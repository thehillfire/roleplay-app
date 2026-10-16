const test = require('node:test');
const assert = require('node:assert/strict');
const { start, signedUp } = require('./helpers');
const { createPush } = require('../src/push');

const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/bottle', keys: { p256dh: 'BPk-key', auth: 'auth-secret' } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('a message left for the next listener starts a conversation when one turns up', async (t) => {
  const sent = [];
  const push = createPush({ publicKey: 'pub', privateKey: 'priv', sendImpl: async (s, payload) => { sent.push(JSON.parse(payload)); } });
  const s = await start({ push });
  t.after(s.stop);
  const talker = await signedUp(s.base);
  await talker('POST', '/api/push/subscribe', { subscription: sub });

  assert.equal((await talker('POST', '/api/bottle', { body: 'whats your snap?' })).status, 400, 'screened');
  assert.equal((await talker('POST', '/api/bottle', { body: 'First draft' })).status, 201);
  assert.equal((await talker('POST', '/api/bottle', { body: "Can't sleep. Work is crushing me and I have nobody to tell." })).status, 201);
  assert.equal((await talker('GET', '/api/bottle')).body.bottle.body, "Can't sleep. Work is crushing me and I have nobody to tell.", 'one at a time: the newest');

  // Someone looking to listen sees that a person is waiting.
  const listener = await signedUp(s.base);
  await wait(30);
  assert.equal((await listener('GET', '/api/presence')).body.waitingToTalk, 1);

  // The talker has closed the app. The listener taps Be a listener and gets the message.
  const lws = await listener.socket();
  t.after(() => lws.close());
  lws.send({ type: 'match.join', role: 'listen' });
  const found = await lws.next('match.found');
  assert.equal(found.partner.handle, talker.user.handle);
  assert.equal(found.fromMessage, true);
  const convo = (await listener('GET', `/api/conversations/${found.conversationId}`)).body;
  assert.deepEqual(convo.messages.map((m) => [m.body, m.fromMe]), [["Can't sleep. Work is crushing me and I have nobody to tell.", false]]);
  await wait(30);
  assert.deepEqual(sent.map((p) => p.body), ['Someone is here to listen to your message']);
  assert.equal((await talker('GET', '/api/bottle')).body.bottle, null, 'picked up');
  assert.equal((await listener('GET', '/api/presence')).body.waitingToTalk, 0);
  assert.equal((await talker('GET', '/api/conversations')).body.conversations[0].id, found.conversationId, 'in the talker list too');

  // A second listener finds nothing left and simply waits.
  const other = await signedUp(s.base);
  const ows = await other.socket();
  t.after(() => ows.close());
  ows.send({ type: 'match.join', role: 'listen' });
  await ows.next('match.waiting');
  await wait(50);
  assert.equal(ows.events.filter((e) => e.type === 'match.found').length, 0);
});

test('messages for the next listener skip blocked pairs, can be withdrawn, and never reach talkers', async (t) => {
  const s = await start();
  t.after(s.stop);
  const a = await signedUp(s.base);
  const b = await signedUp(s.base);
  // A and B chatted before and B blocked A.
  const aws = await a.socket();
  const bws = await b.socket();
  t.after(() => Promise.all([aws.close(), bws.close()]));
  aws.send({ type: 'match.join', role: 'talk' });
  await aws.next('match.waiting');
  bws.send({ type: 'match.join', role: 'listen' });
  const { conversationId } = await bws.next('match.found');
  await b('POST', `/api/conversations/${conversationId}/block`, {});

  await a('POST', '/api/bottle', { body: 'Anyone around tonight? Rough one.' });
  bws.send({ type: 'match.join', role: 'listen' });
  await bws.next('match.waiting');
  await wait(50);
  assert.equal(bws.events.filter((e) => e.type === 'match.found').length, 1, 'blocked: not paired');
  bws.send({ type: 'match.leave' });
  await bws.next('match.left');

  const talker = await signedUp(s.base);
  const tws = await talker.socket();
  t.after(() => tws.close());
  tws.send({ type: 'match.join', role: 'talk' });
  await tws.next('match.waiting');
  await wait(50);
  assert.equal(tws.events.filter((e) => e.type === 'match.found').length, 0, 'talkers are not given messages');
  tws.send({ type: 'match.leave' });

  assert.equal((await a('POST', '/api/bottle/withdraw', {})).status, 200);
  assert.equal((await a('GET', '/api/bottle')).body.bottle, null);
  const listener = await signedUp(s.base);
  const lws = await listener.socket();
  t.after(() => lws.close());
  lws.send({ type: 'match.join', role: 'listen' });
  await lws.next('match.waiting');
  await wait(50);
  assert.equal(lws.events.filter((e) => e.type === 'match.found').length, 0, 'withdrawn');
});

test('a listener picking up a message with crisis language gets the crisis signal', async (t) => {
  const s = await start();
  t.after(s.stop);
  const talker = await signedUp(s.base);
  const res = await talker('POST', '/api/bottle', { body: "Honestly I can't do this anymore." });
  assert.equal(res.body.crisis, true, 'the talker is shown resources right away');
  const listener = await signedUp(s.base);
  const lws = await listener.socket();
  t.after(() => lws.close());
  lws.send({ type: 'match.join', role: 'listen' });
  const { conversationId } = await lws.next('match.found');
  const [first] = (await listener('GET', `/api/conversations/${conversationId}`)).body.messages;
  assert.equal(first.crisis, true);
  const [own] = (await talker('GET', `/api/conversations/${conversationId}`)).body.messages;
  assert.ok(!('crisis' in own), 'the sender view stays as it was');
});

test('a talker with a waiting message who matches live is not given a second listener', async (t) => {
  const s = await start();
  t.after(s.stop);
  const talker = await signedUp(s.base);
  await talker('POST', '/api/bottle', { body: 'Anyone around? Just need to vent for a bit.' });
  const tws = await talker.socket();
  t.after(() => tws.close());
  tws.send({ type: 'match.join', role: 'talk' });
  await tws.next('match.waiting');
  // While they search live, a listener is matched live (not via the message).
  const first = await signedUp(s.base);
  const fws = await first.socket();
  t.after(() => fws.close());
  fws.send({ type: 'match.join', role: 'listen' });
  await fws.next('match.found');
  await wait(50);
  assert.equal((await talker('GET', '/api/bottle')).body.bottle, null, 'withdrawn by the live match');
  const second = await signedUp(s.base);
  const sws = await second.socket();
  t.after(() => sws.close());
  sws.send({ type: 'match.join', role: 'listen' });
  await sws.next('match.waiting');
  await wait(50);
  assert.equal(sws.events.filter((e) => e.type === 'match.found').length, 0);
});

test('waiting messages respect the daily new-people cap', async (t) => {
  const s = await start({ realtime: { dailyMatchLimit: 1 } });
  t.after(s.stop);
  const talker = await signedUp(s.base);
  await talker('POST', '/api/bottle', { body: 'First one. Long day.' });
  const l1 = await signedUp(s.base);
  const w1 = await l1.socket();
  t.after(() => w1.close());
  w1.send({ type: 'match.join', role: 'listen' });
  await w1.next('match.found');
  // Already met one new person today with a limit of 1: the next message waits, unanswered.
  await talker('POST', '/api/bottle', { body: 'Second one. Still a long day.' });
  const l2 = await signedUp(s.base);
  const w2 = await l2.socket();
  t.after(() => w2.close());
  w2.send({ type: 'match.join', role: 'listen' });
  await w2.next('match.waiting');
  await wait(50);
  assert.equal(w2.events.filter((e) => e.type === 'match.found').length, 0);
});

test('old unanswered messages for the next listener are purged', async (t) => {
  const s = await start();
  t.after(s.stop);
  const talker = await signedUp(s.base);
  await talker('POST', '/api/bottle', { body: 'Anyone? Long night.' });
  assert.equal(await s.store.purgeOldBottles(Date.now() - 1000), 0, 'recent ones stay');
  assert.equal(await s.store.purgeOldBottles(Date.now() + 1000), 1);
  assert.equal((await talker('GET', '/api/bottle')).body.bottle, null);
});
