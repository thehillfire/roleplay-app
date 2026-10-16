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

test('history pages backwards with ?before', async (t) => {
  const s = await start({ messageRateLimit: { max: 1000, windowMs: 60000 } });
  t.after(s.stop);
  const alice = await signedUp(s.base);
  const bob = await signedUp(s.base);
  const aws = await alice.socket();
  const bws = await bob.socket();
  t.after(() => Promise.all([aws.close(), bws.close()]));
  aws.send({ type: 'match.join', role: 'talk' });
  await aws.next('match.waiting');
  bws.send({ type: 'match.join', role: 'listen' });
  const { conversationId: id } = await aws.next('match.found');
  for (let i = 1; i <= 55; i += 1) {
    await alice('POST', `/api/conversations/${id}/messages`, { body: `note ${i}` });
    await new Promise((r) => setTimeout(r, 2)); // distinct timestamps
  }
  const first = (await bob('GET', `/api/conversations/${id}`)).body.messages;
  assert.equal(first.length, 50);
  assert.equal(first[0].body, 'note 6');
  assert.equal(first[49].body, 'note 55');
  const older = (await bob('GET', `/api/conversations/${id}?before=${first[0].createdAt}`)).body.messages;
  assert.deepEqual(older.map((m) => m.body), ['note 1', 'note 2', 'note 3', 'note 4', 'note 5']);
});

test('presence counts people online and waiting', async (t) => {
  const s = await start();
  t.after(s.stop);
  const alice = await signedUp(s.base);
  const bob = await signedUp(s.base);
  assert.deepEqual((await alice('GET', '/api/presence')).body, { online: 0, waiting: 0, waitingToTalk: 0 });
  const aws = await alice.socket();
  const bws = await bob.socket();
  t.after(() => Promise.all([aws.close(), bws.close()]));
  aws.send({ type: 'match.join', role: 'talk' });
  await aws.next('match.waiting');
  assert.deepEqual((await alice('GET', '/api/presence')).body, { online: 2, waiting: 1, waitingToTalk: 1 });
});

test('history paging never skips messages that share a timestamp', async (t) => {
  const s = await start();
  t.after(s.stop);
  await signedUp(s.base);
  const bob = await signedUp(s.base);
  const ids = await s.db.query('SELECT id FROM users ORDER BY created_at');
  const [a, b] = ids.rows.map((r) => r.id);
  const { id } = await s.store.openConversation(a, b);
  // 52 messages all in the same millisecond.
  const t0 = Date.now();
  for (let i = 0; i < 52; i += 1) {
    await s.db.query("INSERT INTO messages (id, conversation_id, sender_id, body, status, created_at) VALUES ($1, $2, $3, $4, 'delivered', $5)",
      [`m${String(i).padStart(3, '0')}`, id, a, `same-ms ${i}`, t0]);
  }
  const first = (await bob('GET', `/api/conversations/${id}`)).body.messages;
  const oldest = first[0];
  const rest = (await bob('GET', `/api/conversations/${id}?before=${oldest.createdAt}&beforeId=${oldest.id}`)).body.messages;
  const all = new Set([...rest, ...first].map((m) => m.id));
  assert.equal(all.size, 52, 'every message appears exactly once across pages');
});

test('reading a conversation tells the other person it was seen', async (t) => {
  const s = await start();
  t.after(s.stop);
  const alice = await signedUp(s.base);
  const bob = await signedUp(s.base);
  const aws = await alice.socket();
  const bws = await bob.socket();
  t.after(() => Promise.all([aws.close(), bws.close()]));
  aws.send({ type: 'match.join', role: 'talk' });
  await aws.next('match.waiting');
  bws.send({ type: 'match.join', role: 'listen' });
  const { conversationId: id } = await aws.next('match.found');
  const sent = (await alice('POST', `/api/conversations/${id}/messages`, { body: 'anyone there?' })).body.message;
  assert.equal((await alice('GET', `/api/conversations/${id}`)).body.conversation.partnerReadAt, 0);
  await bob('POST', `/api/conversations/${id}/read`, {});
  const seen = await aws.next('read');
  assert.equal(seen.conversationId, id);
  assert.ok(seen.at >= sent.createdAt);
  assert.ok((await alice('GET', `/api/conversations/${id}`)).body.conversation.partnerReadAt >= sent.createdAt);
});

test('a message can be unsent for 5 minutes: hidden from both, kept for moderators', async (t) => {
  const s = await start({ autoPauseMinReporterAgeMs: 0 });
  t.after(s.stop);
  const alice = await signedUp(s.base);
  const bob = await signedUp(s.base);
  const aws = await alice.socket();
  const bws = await bob.socket();
  t.after(() => Promise.all([aws.close(), bws.close()]));
  aws.send({ type: 'match.join', role: 'talk' });
  await aws.next('match.waiting');
  bws.send({ type: 'match.join', role: 'listen' });
  const { conversationId: id } = await aws.next('match.found');

  const m = (await alice('POST', `/api/conversations/${id}/messages`, { body: 'I overshared, sorry' })).body.message;
  await bws.next('message');
  assert.equal((await bob('POST', `/api/conversations/${id}/messages/${m.id}/unsend`, {})).status, 409, "can't unsend someone else's");
  assert.equal((await alice('POST', `/api/conversations/${id}/messages/${m.id}/unsend`, {})).status, 200);
  assert.deepEqual(await bws.next('message.unsent'), { type: 'message.unsent', conversationId: id, messageId: m.id, seen: true });

  for (const who of [alice, bob]) {
    const [msg] = (await who('GET', `/api/conversations/${id}`)).body.messages;
    assert.equal(msg.status, 'unsent');
    assert.equal(msg.body, '');
  }
  assert.equal((await bob('GET', '/api/conversations')).body.conversations[0].lastMessage, null);

  // Moderators still see what was said if it's reported.
  await bob('POST', `/api/conversations/${id}/report`, { reason: 'harassment', block: false });
  const [report] = await s.store.listReports();
  assert.equal(report.snapshot[0].body, 'I overshared, sorry');
  assert.equal(report.snapshot[0].unsent, true);

  // Too old to unsend.
  const old = (await alice('POST', `/api/conversations/${id}/messages`, { body: 'older' })).body.message;
  await s.db.query('UPDATE messages SET created_at = $1 WHERE id = $2', [Date.now() - 6 * 60 * 1000, old.id]);
  assert.equal((await alice('POST', `/api/conversations/${id}/messages/${old.id}/unsend`, {})).status, 409);
});

test('the receiver can react to a message with a gentle emoji', async (t) => {
  const s = await start();
  t.after(s.stop);
  const alice = await signedUp(s.base);
  const bob = await signedUp(s.base);
  const aws = await alice.socket();
  const bws = await bob.socket();
  t.after(() => Promise.all([aws.close(), bws.close()]));
  aws.send({ type: 'match.join', role: 'talk' });
  await aws.next('match.waiting');
  bws.send({ type: 'match.join', role: 'listen' });
  const { conversationId: id } = await aws.next('match.found');
  const m = (await alice('POST', `/api/conversations/${id}/messages`, { body: 'today was a lot' })).body.message;
  const url = `/api/conversations/${id}/messages/${m.id}/react`;

  assert.equal((await alice('POST', url, { reaction: '💙' })).status, 404, "can't react to your own message");
  assert.equal((await bob('POST', url, { reaction: '😂' })).status, 400, 'only the gentle set');
  assert.equal((await bob('POST', url, { reaction: '🫂' })).status, 200);
  const pushed = await aws.next('message.reacted');
  assert.equal(pushed.reaction, '🫂');
  assert.equal((await alice('GET', `/api/conversations/${id}`)).body.messages[0].reaction, '🫂');
  await bob('POST', url, { reaction: null });
  assert.equal((await alice('GET', `/api/conversations/${id}`)).body.messages[0].reaction, null);
});
