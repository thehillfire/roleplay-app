const test = require('node:test');
const assert = require('node:assert/strict');
const { start, signedUp } = require('./helpers');
const { createPayments } = require('../src/payments');

async function pair(s) {
  const alice = await signedUp(s.base);
  const bob = await signedUp(s.base);
  const aws = await alice.socket();
  const bws = await bob.socket();
  aws.send({ type: 'match.join', role: 'talk' });
  await aws.next('match.waiting');
  bws.send({ type: 'match.join', role: 'listen' });
  const { conversationId: id } = await aws.next('match.found');
  await bws.next('match.found');
  return { alice, bob, aws, bws, id, close: () => Promise.all([aws.close(), bws.close()]) };
}

const userId = async (s, api) => (await s.db.query('SELECT id FROM users WHERE handle = $1', [api.user.handle])).rows[0].id;

test('with payments off, connecting is free and reveals both sides only when both agree', async (t) => {
  const s = await start({ payments: createPayments({ secretKey: '', webhookSecret: '' }) });
  t.after(s.stop);
  const p = await pair(s);
  t.after(p.close);

  assert.deepEqual((await p.alice('GET', '/api/auth/me')).body.billing.enabled, false);
  const req = await p.alice('POST', `/api/conversations/${p.id}/connect`, { name: 'Jav', contact: '@jav' });
  assert.equal(req.status, 200);
  assert.deepEqual(req.body.connection, { status: 'pending', mine: true });

  const pushed = await p.bws.next('connect.updated');
  assert.deepEqual(pushed.connection, { status: 'pending', mine: false }, 'Bob sees a request, not a name');
  const bobView = (await p.bob('GET', `/api/conversations/${p.id}`)).body.conversation.connection;
  assert.deepEqual(bobView, { status: 'pending', mine: false });

  assert.equal((await p.alice('POST', `/api/conversations/${p.id}/connect`, { name: 'Jav' })).status, 409, 'no double request');

  const accept = await p.bob('POST', `/api/conversations/${p.id}/connect`, { name: 'Robert' });
  assert.deepEqual(accept.body.connection, { status: 'accepted', me: { name: 'Robert', contact: null }, partner: { name: 'Jav', contact: '@jav' } });
  const aliceSees = await p.aws.next('connect.updated');
  assert.deepEqual(aliceSees.connection.partner, { name: 'Robert', contact: null });

  // Connected people may now share contact details.
  const msg = await p.alice('POST', `/api/conversations/${p.id}/messages`, { body: 'text me 555 123 4567' });
  assert.equal(msg.body.message.status, 'delivered');
});

test('declining keeps both anonymous and is final', async (t) => {
  const s = await start({ payments: createPayments({ secretKey: '', webhookSecret: '' }) });
  t.after(s.stop);
  const p = await pair(s);
  t.after(p.close);
  await p.alice('POST', `/api/conversations/${p.id}/connect`, { name: 'Jav' });
  assert.equal((await p.alice('POST', `/api/conversations/${p.id}/connect/decline`, {})).status, 404, "can't decline your own request");
  const declined = await p.bob('POST', `/api/conversations/${p.id}/connect/decline`, {});
  assert.deepEqual(declined.body.connection, { status: 'declined', mine: false });
  assert.equal((await p.aws.next('connect.updated')).connection.status, 'declined');
  const again = await p.alice('POST', `/api/conversations/${p.id}/connect`, { name: 'Jav' });
  assert.equal(again.status, 409);
  const view = (await p.alice('GET', `/api/conversations/${p.id}`)).body.conversation.connection;
  assert.deepEqual(view, { status: 'declined', mine: true });
  const msg = await p.alice('POST', `/api/conversations/${p.id}/messages`, { body: 'my email is a@b.com' });
  assert.equal(msg.body.message.status, 'held', 'contact info stays blocked without a connection');
});

test('with payments on, requesting costs a credit that comes back if declined or cancelled', async (t) => {
  const payments = createPayments({ secretKey: 'sk_test_x', webhookSecret: 'whsec_x' });
  const s = await start({ payments });
  t.after(s.stop);
  const p = await pair(s);
  t.after(p.close);
  const aliceId = await userId(s, p.alice);

  const noCredit = await p.alice('POST', `/api/conversations/${p.id}/connect`, { name: 'Jav' });
  assert.equal(noCredit.status, 402);
  assert.equal(noCredit.body.needsCredit, true);

  await s.store.addCredits(aliceId, 1);
  assert.equal((await p.alice('POST', `/api/conversations/${p.id}/connect`, { name: 'Jav' })).status, 200);
  assert.equal((await p.alice('GET', '/api/auth/me')).body.user.connectCredits, 0);

  await p.alice('POST', `/api/conversations/${p.id}/connect/cancel`, {});
  assert.equal((await p.alice('GET', '/api/auth/me')).body.user.connectCredits, 1, 'cancel refunds');

  await p.alice('POST', `/api/conversations/${p.id}/connect`, { name: 'Jav' });
  await p.bob('POST', `/api/conversations/${p.id}/connect/decline`, {});
  assert.equal((await p.alice('GET', '/api/auth/me')).body.user.connectCredits, 1, 'decline refunds');
  assert.equal((await p.bob('GET', '/api/auth/me')).body.user.connectCredits, 0);
});

test('accepting is free even with payments on', async (t) => {
  const s = await start({ payments: createPayments({ secretKey: 'sk_test_x', webhookSecret: 'whsec_x' }) });
  t.after(s.stop);
  const p = await pair(s);
  t.after(p.close);
  await s.store.addCredits(await userId(s, p.alice), 1);
  await p.alice('POST', `/api/conversations/${p.id}/connect`, { name: 'Jav' });
  const accept = await p.bob('POST', `/api/conversations/${p.id}/connect`, { name: 'Robert' });
  assert.equal(accept.body.connection.status, 'accepted');
});

test('checkout creates a Stripe session; webhooks grant credits once and reject forgeries', async (t) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ url: 'https://checkout.stripe.com/c/pay/cs_test_1' }) };
  };
  const payments = createPayments({ secretKey: 'sk_test_x', webhookSecret: 'whsec_x', priceCents: 999, fetchImpl });
  const s = await start({ payments });
  t.after(s.stop);
  const alice = await signedUp(s.base);
  const aliceId = await userId(s, alice);

  const checkout = await alice('POST', '/api/billing/checkout', {});
  assert.equal(checkout.body.url, 'https://checkout.stripe.com/c/pay/cs_test_1');
  assert.equal(calls[0].url, 'https://api.stripe.com/v1/checkout/sessions');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk_test_x');
  const form = new URLSearchParams(calls[0].init.body);
  assert.equal(form.get('client_reference_id'), aliceId);
  assert.equal(form.get('line_items[0][price_data][unit_amount]'), '999');

  const event = JSON.stringify({
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_test_1', payment_status: 'paid', client_reference_id: aliceId, amount_total: 999, metadata: { credits: '1' } } },
  });
  const hook = (body, signature) => fetch(`${s.base}/api/billing/webhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature }, body,
  });

  assert.equal((await hook(event, 't=1,v1=deadbeef')).status, 400, 'bad signature');
  assert.equal((await hook(event, payments.sign(event, Math.floor(Date.now() / 1000) - 3600))).status, 400, 'stale signature');
  assert.equal((await alice('GET', '/api/auth/me')).body.user.connectCredits, 0);

  assert.equal((await hook(event, payments.sign(event))).status, 200);
  assert.equal((await hook(event, payments.sign(event))).status, 200, 'Stripe retries are fine');
  assert.equal((await alice('GET', '/api/auth/me')).body.user.connectCredits, 1, 'credited exactly once');

  const tampered = event.replace('"credits":"1"', '"credits":"9"');
  assert.equal((await hook(tampered, payments.sign(event))).status, 400, 'body must match signature');
});

test('checkout is unavailable while payments are off', async (t) => {
  const s = await start({ payments: createPayments({ secretKey: '', webhookSecret: '' }) });
  t.after(s.stop);
  const alice = await signedUp(s.base);
  assert.equal((await alice('POST', '/api/billing/checkout', {})).status, 503);
});

test('declining twice at once refunds the credit only once', async (t) => {
  const s = await start({ payments: createPayments({ secretKey: 'sk_test_x', webhookSecret: 'whsec_x' }) });
  t.after(s.stop);
  const p = await pair(s);
  t.after(p.close);
  const aliceId = await userId(s, p.alice);
  await s.store.addCredits(aliceId, 1);
  await p.alice('POST', `/api/conversations/${p.id}/connect`, { name: 'Jav' });
  const results = await Promise.all([
    p.bob('POST', `/api/conversations/${p.id}/connect/decline`, {}),
    p.bob('POST', `/api/conversations/${p.id}/connect/decline`, {}),
    p.alice('POST', `/api/conversations/${p.id}/connect/cancel`, {}),
  ]);
  assert.equal(results.filter((r) => r.status === 200).length, 1, 'exactly one wins');
  assert.equal((await p.alice('GET', '/api/auth/me')).body.user.connectCredits, 1, 'refunded exactly once');
});

test('asking to connect, cancelling and asking again stops after three asks a day', async (t) => {
  const s = await start({ payments: createPayments({ secretKey: '', webhookSecret: '' }) });
  t.after(s.stop);
  const p = await pair(s);
  t.after(p.close);
  for (let i = 0; i < 3; i++) {
    assert.equal((await p.alice('POST', `/api/conversations/${p.id}/connect`, { name: 'Jav' })).status, 200);
    assert.equal((await p.alice('POST', `/api/conversations/${p.id}/connect/cancel`, {})).status, 200);
  }
  const fourth = await p.alice('POST', `/api/conversations/${p.id}/connect`, { name: 'Jav' });
  assert.equal(fourth.status, 429);
  assert.match(fourth.body.error, /try again tomorrow/);
  // The other person can still ask (and that accept path stays open).
  assert.equal((await p.bob('POST', `/api/conversations/${p.id}/connect`, { name: 'Robert' })).status, 200);
  assert.equal((await p.alice('POST', `/api/conversations/${p.id}/connect`, { name: 'Jav' })).body.connection.status, 'accepted');
});

test('a burst of parallel connect asks still counts each one', async (t) => {
  const s = await start({ payments: createPayments({ secretKey: '', webhookSecret: '' }) });
  t.after(s.stop);
  const p = await pair(s);
  t.after(p.close);
  for (let i = 0; i < 3; i++) {
    const results = await Promise.all([1, 2, 3].map(() => p.alice('POST', `/api/conversations/${p.id}/connect`, { name: 'Jav' })));
    if (results.some((r) => r.status === 200)) await p.alice('POST', `/api/conversations/${p.id}/connect/cancel`, {});
  }
  assert.equal((await p.alice('POST', `/api/conversations/${p.id}/connect`, { name: 'Jav' })).status, 429);
});
