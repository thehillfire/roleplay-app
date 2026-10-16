const test = require('node:test');
const assert = require('node:assert/strict');
const { start, client, signedUp } = require('./helpers');

async function matchPair(s) {
  const alice = await signedUp(s.base);
  const bob = await signedUp(s.base);
  const aws = await alice.socket();
  const bws = await bob.socket();
  aws.send({ type: 'match.join', role: 'talk' });
  await aws.next('match.waiting');
  bws.send({ type: 'match.join', role: 'listen' });
  const [am, bm] = await Promise.all([aws.next('match.found'), bws.next('match.found')]);
  return { alice, bob, aws, bws, am, bm };
}

test('two strangers match and chat in real time', async (t) => {
  const s = await start();
  t.after(s.stop);
  const { alice, bob, aws, bws, am, bm } = await matchPair(s);
  t.after(() => Promise.all([aws.close(), bws.close()]));

  assert.equal(am.conversationId, bm.conversationId);
  assert.equal(am.partner.handle, bob.user.handle);
  assert.equal(bm.partner.handle, alice.user.handle);
  assert.equal(am.isNew, true);

  const id = am.conversationId;
  const sent = await alice('POST', `/api/conversations/${id}/messages`, { body: '  Rough day. Rent is due and I am short.  ' });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.message.body, 'Rough day. Rent is due and I am short.');
  assert.equal(sent.body.message.fromMe, true);

  const pushed = await bws.next('message');
  assert.equal(pushed.message.body, 'Rough day. Rent is due and I am short.');
  assert.equal(pushed.message.fromMe, false);
  assert.ok(!('senderId' in pushed.message), 'no user ids leak to the client');

  aws.send({ type: 'typing', conversationId: id });
  assert.equal((await bws.next('typing')).conversationId, id);

  const bobList = await bob('GET', '/api/conversations');
  assert.equal(bobList.body.conversations[0].unread, 1);
  assert.equal(bobList.body.conversations[0].partner.handle, alice.user.handle);
  assert.equal(bobList.body.conversations[0].partner.online, true);
  assert.deepEqual(bobList.body.conversations[0].lastMessage, { body: 'Rough day. Rent is due and I am short.', fromMe: false });

  await bob('POST', `/api/conversations/${id}/read`, {});
  assert.equal((await bob('GET', '/api/conversations')).body.conversations[0].unread, 0);

  await bob('POST', `/api/conversations/${id}/messages`, { body: 'Been there. You are not alone.' });
  const history = await alice('GET', `/api/conversations/${id}`);
  assert.deepEqual(history.body.messages.map((m) => [m.fromMe, m.body]), [
    [true, 'Rough day. Rent is due and I am short.'],
    [false, 'Been there. You are not alone.'],
  ]);
  assert.equal(history.body.conversation.partner.handle, bob.user.handle);
});

test('matching the same person again continues the same thread', async (t) => {
  const s = await start();
  t.after(s.stop);
  const { aws, bws, am } = await matchPair(s);
  t.after(() => Promise.all([aws.close(), bws.close()]));
  aws.send({ type: 'match.join', role: 'talk' });
  await aws.next('match.waiting');
  bws.send({ type: 'match.join', role: 'listen' });
  const again = await aws.next('match.found');
  assert.equal(again.conversationId, am.conversationId);
  assert.equal(again.isNew, false);
});

test("outsiders can't read or post in someone else's conversation", async (t) => {
  const s = await start();
  t.after(s.stop);
  const { aws, bws, am } = await matchPair(s);
  t.after(() => Promise.all([aws.close(), bws.close()]));
  const eve = await signedUp(s.base);
  assert.equal((await eve('GET', `/api/conversations/${am.conversationId}`)).status, 404);
  assert.equal((await eve('POST', `/api/conversations/${am.conversationId}/messages`, { body: 'hi' })).status, 404);
  assert.equal((await eve('GET', '/api/conversations')).body.conversations.length, 0);
  assert.equal((await client(s.base)('GET', '/api/conversations')).status, 401);
});

test('blocked people are never matched and cannot message', async (t) => {
  const s = await start();
  t.after(s.stop);
  const { alice, bob, aws, bws, am } = await matchPair(s);
  t.after(() => Promise.all([aws.close(), bws.close()]));
  const aliceId = (await s.store.findUserByEmail((await s.db.query('SELECT email FROM users WHERE handle = $1', [alice.user.handle])).rows[0].email)).id;
  const bobId = (await s.store.findUserByEmail((await s.db.query('SELECT email FROM users WHERE handle = $1', [bob.user.handle])).rows[0].email)).id;
  await s.store.block(aliceId, bobId);

  assert.equal((await bob('POST', `/api/conversations/${am.conversationId}/messages`, { body: 'hello?' })).status, 403);
  assert.equal((await bob('GET', '/api/conversations')).body.conversations.length, 0);

  aws.send({ type: 'match.join', role: 'talk' });
  await aws.next('match.waiting');
  bws.send({ type: 'match.join', role: 'listen' });
  await bws.next('match.waiting');
  await assert.rejects(aws.next('match.found', 300));
});

test('message validation and rate limiting', async (t) => {
  const s = await start({ messageRateLimit: { max: 3, windowMs: 60000 } });
  t.after(s.stop);
  const { alice, aws, bws, am } = await matchPair(s);
  t.after(() => Promise.all([aws.close(), bws.close()]));
  const url = `/api/conversations/${am.conversationId}/messages`;
  assert.equal((await alice('POST', url, { body: '   ' })).status, 400);
  assert.equal((await alice('POST', url, { body: 'x'.repeat(2001) })).status, 400);
  assert.equal((await alice('POST', url, { body: 42 })).status, 400);
  assert.equal((await alice('POST', url, { body: 'ok' })).status, 429, 'the three bad requests count toward the limit');
});

test('sockets need a session and a same-site origin', async (t) => {
  const s = await start();
  t.after(s.stop);
  const anon = client(s.base);
  await assert.rejects(anon.socket(), { status: 401 });
  const alice = await signedUp(s.base);
  await assert.rejects(alice.socket({ Origin: 'https://evil.example' }), { status: 403 });
  const ok = await alice.socket({ Origin: s.base });
  await ok.close();
});

test('closing the last socket leaves the queue', async (t) => {
  const s = await start();
  t.after(s.stop);
  const alice = await signedUp(s.base);
  const aws = await alice.socket();
  aws.send({ type: 'match.join', role: 'talk' });
  await aws.next('match.waiting');
  assert.equal(s.server.realtime.matchmaker.size, 1);
  await aws.close();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(s.server.realtime.matchmaker.size, 0);
});
