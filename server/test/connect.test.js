const test = require('node:test');
const assert = require('node:assert/strict');
const { start, signedUp } = require('./helpers');

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

test('connecting reveals both sides only when both agree', async (t) => {
  const s = await start();
  t.after(s.stop);
  const p = await pair(s);
  t.after(p.close);

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
  const s = await start();
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

test('connecting is free for everyone: no credits, nothing to buy', async (t) => {
  const s = await start();
  t.after(s.stop);
  const p = await pair(s);
  t.after(p.close);
  for (let i = 0; i < 2; i++) {
    const asked = await p.alice('POST', `/api/conversations/${p.id}/connect`, { name: 'Jav' });
    assert.equal(asked.status, 200, 'asking needs nothing');
    assert.equal((await p.alice('POST', `/api/conversations/${p.id}/connect/cancel`, {})).status, 200);
  }
  const me = (await p.alice('GET', '/api/auth/me')).body;
  assert.equal(me.user.connectCredits, undefined);
  assert.equal(me.billing, undefined);
  for (const path of ['/api/billing/checkout', '/api/billing/plus', '/api/billing/portal']) {
    assert.equal((await p.alice('POST', path, {})).status, 404, path);
  }
});

test('declining twice at once settles it exactly once', async (t) => {
  const s = await start();
  t.after(s.stop);
  const p = await pair(s);
  t.after(p.close);
  await p.alice('POST', `/api/conversations/${p.id}/connect`, { name: 'Jav' });
  const results = await Promise.all([
    p.bob('POST', `/api/conversations/${p.id}/connect/decline`, {}),
    p.bob('POST', `/api/conversations/${p.id}/connect/decline`, {}),
    p.alice('POST', `/api/conversations/${p.id}/connect/cancel`, {}),
  ]);
  assert.equal(results.filter((r) => r.status === 200).length, 1, 'exactly one wins');
});

test('asking to connect, cancelling and asking again stops after three asks a day', async (t) => {
  const s = await start();
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
  const { rows } = await s.db.query('SELECT COUNT(*) AS n FROM connect_asks');
  assert.equal(Number(rows[0].n), 3, 'kept in the database (survives a restart); the refused ask is not counted');
  // The other person can still ask (and that accept path stays open).
  assert.equal((await p.bob('POST', `/api/conversations/${p.id}/connect`, { name: 'Robert' })).status, 200);
  assert.equal((await p.alice('POST', `/api/conversations/${p.id}/connect`, { name: 'Jav' })).body.connection.status, 'accepted');
});

test('a burst of parallel connect asks never gets past the daily limit', async (t) => {
  const s = await start();
  t.after(s.stop);
  const p = await pair(s);
  t.after(p.close);
  let granted = 0;
  for (let i = 0; i < 5; i++) {
    const results = await Promise.all([1, 2, 3].map(() => p.alice('POST', `/api/conversations/${p.id}/connect`, { name: 'Jav' })));
    const ok = results.filter((r) => r.status === 200).length;
    assert.ok(ok <= 1, 'one request per chat at a time');
    granted += ok;
    if (ok) await p.alice('POST', `/api/conversations/${p.id}/connect/cancel`, {});
  }
  assert.ok(granted >= 1 && granted <= 3, `granted ${granted}`);
  const { rows } = await s.db.query('SELECT COUNT(*) AS n FROM connect_asks');
  assert.equal(Number(rows[0].n), granted, 'refused and failed asks are not counted');
});
