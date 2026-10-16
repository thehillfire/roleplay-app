const test = require('node:test');
const assert = require('node:assert/strict');
const { start, signedUp } = require('./helpers');
const { createPayments } = require('../src/payments');

function setup() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, form: new URLSearchParams(init.body || '') });
    if (calls.failNext) { calls.failNext = false; return { ok: false, status: 500, json: async () => ({}) }; }
    return { ok: true, status: 200, json: async () => ({ url: url.includes('portal') ? 'https://billing.stripe.com/p/session' : 'https://checkout.stripe.com/c/pay/cs_sub' }) };
  };
  return { calls, payments: createPayments({ secretKey: 'sk_test_x', webhookSecret: 'whsec_x', fetchImpl }) };
}

async function hook(s, payments, event) {
  const body = JSON.stringify(event);
  const res = await fetch(`${s.base}/api/billing/webhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': payments.sign(body) }, body,
  });
  assert.equal(res.status, 200);
}

const periodEnd = () => Math.floor(Date.now() / 1000) + 30 * 86400;

test('Plus: subscribe, first invoice grants a month and 3 credits, cancel ends it', async (t) => {
  const { calls, payments } = setup();
  const s = await start({ payments, publicUrl: 'https://kindred.example' });
  t.after(s.stop);
  const alice = await signedUp(s.base);
  const aliceId = (await s.db.query('SELECT id FROM users WHERE handle = $1', [alice.user.handle])).rows[0].id;

  const checkout = await alice('POST', '/api/billing/plus', {});
  assert.equal(checkout.body.url, 'https://checkout.stripe.com/c/pay/cs_sub');
  const form = calls[0].form;
  assert.equal(form.get('mode'), 'subscription');
  assert.equal(form.get('line_items[0][price_data][recurring][interval]'), 'month');
  assert.equal(form.get('subscription_data[metadata][user_id]'), aliceId);

  // Checkout completes: linked, but no credits yet and NOT treated as a one-off purchase.
  await hook(s, payments, { type: 'checkout.session.completed', data: { object: { id: 'cs_sub', mode: 'subscription', payment_status: 'paid', client_reference_id: aliceId, customer: 'cus_1', subscription: 'sub_1', metadata: { user_id: aliceId } } } });
  let me = (await alice('GET', '/api/auth/me')).body.user;
  assert.equal(me.connectCredits, 0);
  assert.equal(me.plus, false);

  // First invoice (2025+ shape: parent.subscription_details).
  const invoice = { id: 'in_1', amount_paid: 499, customer: 'cus_1', parent: { subscription_details: { subscription: 'sub_1', metadata: { user_id: aliceId } } }, lines: { data: [{ period: { end: periodEnd() } }] } };
  await hook(s, payments, { type: 'invoice.paid', data: { object: invoice } });
  await hook(s, payments, { type: 'invoice.paid', data: { object: invoice } }); // retry
  me = (await alice('GET', '/api/auth/me')).body.user;
  assert.equal(me.plus, true);
  assert.equal(me.connectCredits, 3, 'credited once despite the retry');

  // Manage via the portal.
  const portal = await alice('POST', '/api/billing/portal', {});
  assert.equal(portal.body.url, 'https://billing.stripe.com/p/session');
  assert.equal(calls[1].form.get('customer'), 'cus_1');

  await hook(s, payments, { type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', items: { data: [{ current_period_end: Math.floor(Date.now() / 1000) - 1 }] } } } });
  me = (await alice('GET', '/api/auth/me')).body.user;
  assert.equal(me.plus, false);
  assert.equal(me.connectCredits, 3, 'credits already granted stay');
});

test('Plus: an invoice that arrives before checkout (older shape) still finds the account', async (t) => {
  const { payments } = setup();
  const s = await start({ payments });
  t.after(s.stop);
  const bob = await signedUp(s.base);
  const bobId = (await s.db.query('SELECT id FROM users WHERE handle = $1', [bob.user.handle])).rows[0].id;
  await hook(s, payments, { type: 'invoice.paid', data: { object: { id: 'in_9', amount_paid: 499, customer: 'cus_9', subscription: 'sub_9', subscription_details: { metadata: { user_id: bobId } }, lines: { data: [{ period: { end: periodEnd() } }] } } } });
  const me = (await bob('GET', '/api/auth/me')).body.user;
  assert.equal(me.plus, true);
  assert.equal(me.connectCredits, 3);
  assert.equal((await s.store.userBySubscription('sub_9')).id, bobId);
});

test('Plus members can meet more new people per day', async (t) => {
  const { payments } = setup();
  const s = await start({ payments, realtime: { dailyMatchLimit: 1 } });
  t.after(s.stop);
  const alice = await signedUp(s.base);
  const aliceId = (await s.db.query('SELECT id FROM users WHERE handle = $1', [alice.user.handle])).rows[0].id;
  await s.store.extendPlus(aliceId, Date.now() + 86400000);
  const aws = await alice.socket();
  t.after(() => aws.close());
  for (let i = 0; i < 2; i += 1) {
    const other = await signedUp(s.base);
    const ows = await other.socket();
    aws.send({ type: 'match.join', role: 'talk' });
    await aws.next('match.waiting');
    ows.send({ type: 'match.join', role: 'listen' });
    await aws.next('match.found');
    await ows.close();
  }
  assert.ok(true, 'two matches with a base limit of 1');
});

async function plusMember(s, payments, { subscription = 'sub_x', periodEndSec = periodEnd() } = {}) {
  const api = await signedUp(s.base);
  const id = (await s.db.query('SELECT id FROM users WHERE handle = $1', [api.user.handle])).rows[0].id;
  await hook(s, payments, { type: 'checkout.session.completed', data: { object: { id: `cs_${subscription}`, mode: 'subscription', client_reference_id: id, customer: `cus_${subscription}`, subscription } } });
  await hook(s, payments, { type: 'invoice.paid', data: { object: { id: `in_${subscription}`, amount_paid: 499, subscription, billing_reason: 'subscription_create', lines: { data: [{ period: { end: periodEndSec } }] } } } });
  return { api, id };
}

test('Plus: a cancellation after failed renewals never turns Plus back on', async (t) => {
  const { payments } = setup();
  const s = await start({ payments });
  t.after(s.stop);
  // Paid month already over; renewal failed, so Plus has lapsed.
  const { api } = await plusMember(s, payments, { subscription: 'sub_lapsed', periodEndSec: Math.floor(Date.now() / 1000) - 60 });
  assert.equal((await api('GET', '/api/auth/me')).body.user.plus, false);
  // Stripe gives up and cancels; its period end is the unpaid month.
  await hook(s, payments, { type: 'customer.subscription.deleted', data: { object: { id: 'sub_lapsed', current_period_end: periodEnd(), ended_at: Math.floor(Date.now() / 1000) } } });
  const me = (await api('GET', '/api/auth/me')).body.user;
  assert.equal(me.plus, false);
  assert.equal(me.hasSubscription, false);
});

test('Plus: one subscription at a time, even while a renewal is failing', async (t) => {
  const { payments } = setup();
  const s = await start({ payments, publicUrl: 'https://kindred.example' });
  t.after(s.stop);
  const { api } = await plusMember(s, payments, { subscription: 'sub_pastdue', periodEndSec: Math.floor(Date.now() / 1000) - 60 });
  const me = (await api('GET', '/api/auth/me')).body.user;
  assert.equal(me.plus, false);
  assert.equal(me.hasSubscription, true, 'the app can offer Manage subscription');
  assert.equal((await api('POST', '/api/billing/plus', {})).status, 409);
  assert.equal((await api('POST', '/api/billing/portal', {})).status, 200);
});

test('Plus: mid-cycle invoices extend Plus but grant no extra credits', async (t) => {
  const { payments } = setup();
  const s = await start({ payments });
  t.after(s.stop);
  const { api } = await plusMember(s, payments, { subscription: 'sub_upd' });
  await hook(s, payments, { type: 'invoice.paid', data: { object: { id: 'in_upd2', amount_paid: 100, subscription: 'sub_upd', billing_reason: 'subscription_update', lines: { data: [{ period: { end: periodEnd() } }] } } } });
  assert.equal((await api('GET', '/api/auth/me')).body.user.connectCredits, 3);
});

test('Plus: deleting the account cancels the subscription first, and later invoices are ignored', async (t) => {
  const { calls, payments } = setup();
  const s = await start({ payments });
  t.after(s.stop);
  const { api, id } = await plusMember(s, payments, { subscription: 'sub_del' });

  calls.failNext = true;
  const refused = await api('POST', '/api/account/delete', { password: 'quiet-harbor-9' });
  assert.equal(refused.status, 502, "not deleted while we can't stop the billing");
  assert.equal((await api('GET', '/api/auth/me')).body.user.handle, api.user.handle);

  assert.equal((await api('POST', '/api/account/delete', { password: 'quiet-harbor-9' })).status, 200);
  const cancel = calls.filter((c) => c.method === 'DELETE');
  assert.equal(cancel.at(-1).url, 'https://api.stripe.com/v1/subscriptions/sub_del');

  // A renewal that was already in flight finds nobody to credit.
  await hook(s, payments, { type: 'invoice.paid', data: { object: { id: 'in_del2', amount_paid: 499, subscription: 'sub_del', subscription_details: { metadata: { user_id: id } }, billing_reason: 'subscription_cycle', lines: { data: [{ period: { end: periodEnd() } }] } } } });
  const { rows } = await s.db.query('SELECT connect_credits, plus_subscription_id FROM users WHERE id = $1', [id]);
  assert.equal(Number(rows[0].connect_credits), 3);
  assert.equal(rows[0].plus_subscription_id, null);
});

test('Plus: a second subscription paid at the same time is cancelled and refunded', async (t) => {
  const { calls, payments } = setup();
  const s = await start({ payments });
  t.after(s.stop);
  const { api, id } = await plusMember(s, payments, { subscription: 'sub_first' });
  // The second checkout completes, then its first invoice arrives.
  await hook(s, payments, { type: 'checkout.session.completed', data: { object: { id: 'cs_dup', mode: 'subscription', client_reference_id: id, customer: 'cus_sub_first', subscription: 'sub_dup' } } });
  await hook(s, payments, { type: 'invoice.paid', data: { object: { id: 'in_dup', amount_paid: 499, payment_intent: 'pi_dup', subscription: 'sub_dup', subscription_details: { metadata: { user_id: id } }, billing_reason: 'subscription_create', lines: { data: [{ period: { end: periodEnd() } }] } } } });

  assert.ok(calls.some((c) => c.method === 'DELETE' && c.url === 'https://api.stripe.com/v1/subscriptions/sub_dup'), 'cancelled');
  const refund = calls.find((c) => c.url === 'https://api.stripe.com/v1/refunds');
  assert.equal(refund.form.get('payment_intent'), 'pi_dup');
  const me = (await api('GET', '/api/auth/me')).body.user;
  assert.equal(me.connectCredits, 3, 'no extra credits for the duplicate');
  assert.equal((await s.store.getUser(id)).plusSubscriptionId, 'sub_first', 'the first stays linked');
});
