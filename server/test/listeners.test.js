const test = require('node:test');
const assert = require('node:assert/strict');
const { start, signedUp } = require('./helpers');
const { createPush } = require('../src/push');

const sub = (n) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, keys: { p256dh: 'BPk-key', auth: 'auth-secret' } });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function setup(t) {
  const sent = [];
  const push = createPush({ publicKey: 'pub', privateKey: 'priv', sendImpl: async (s, payload) => { sent.push({ endpoint: s.endpoint, payload: JSON.parse(payload) }); } });
  const s = await start({ push, realtime: { listenerAlert: { afterMs: 150, cooldownMs: 60 * 60 * 1000, perTalkerMs: 60 * 60 * 1000, batch: 2 } } });
  t.after(s.stop);
  return { s, sent };
}

async function onCall(base, n) {
  const listener = await signedUp(base);
  assert.equal((await listener('POST', '/api/push/subscribe', { subscription: sub(n) })).status, 201);
  const res = await listener('POST', '/api/account/listener-alerts', { on: true });
  assert.equal(res.status, 200);
  return listener;
}

test('a talker left waiting alerts a few on-call listeners, once, without saying who', async (t) => {
  const { s, sent } = await setup(t);
  const listeners = [await onCall(s.base, 1), await onCall(s.base, 2), await onCall(s.base, 3)];
  assert.equal((await listeners[0]('GET', '/api/auth/me')).body.user.listenerAlerts, true);
  const notOnCall = await signedUp(s.base);
  await notOnCall('POST', '/api/push/subscribe', { subscription: sub(9) });

  const talker = await signedUp(s.base);
  const ws = await talker.socket();
  ws.send({ type: 'match.join', role: 'talk' });
  await ws.next('match.waiting');
  await wait(400);
  assert.equal(sent.length, 2, 'batch size caps the alert');
  assert.ok(sent.every((p) => p.endpoint !== sub(9).endpoint), 'only people who opted in');
  assert.deepEqual(sent[0].payload, { title: 'Someone needs a listener', body: 'A person on Kindred is waiting to talk. Open the app if you have a few minutes.', tag: 'listener-needed' });
  assert.ok(!JSON.stringify(sent).includes(talker.user.handle), "the talker's handle never goes out");

  // Leaving and rejoining doesn't page people again.
  ws.send({ type: 'match.leave' });
  await ws.next('match.left');
  ws.send({ type: 'match.join', role: 'talk' });
  await ws.next('match.waiting');
  await wait(400);
  assert.equal(sent.length, 2);
  await ws.close();
});

test('no alert when the talker is matched quickly, or for listeners who are online or blocked', async (t) => {
  const { s, sent } = await setup(t);
  const online = await onCall(s.base, 1);
  const onlineWs = await online.socket();
  const blockedListener = await onCall(s.base, 2);

  // The blocked listener blocks the talker after a past chat.
  const talker = await signedUp(s.base);
  const tws = await talker.socket();
  const bws = await blockedListener.socket();
  tws.send({ type: 'match.join', role: 'talk' });
  await tws.next('match.waiting');
  bws.send({ type: 'match.join', role: 'listen' });
  const { conversationId } = await tws.next('match.found');
  assert.equal((await blockedListener('POST', `/api/conversations/${conversationId}/block`, {})).status, 200);
  await bws.close();
  await wait(300);
  assert.equal(sent.filter((p) => p.payload.tag === 'listener-needed').length, 0, 'matched right away: nobody paged');

  const talker2 = await signedUp(s.base);
  const t2 = await talker2.socket();
  const helper = await signedUp(s.base);
  const hws = await helper.socket();
  // Talker 2 is matched by someone within the delay.
  t2.send({ type: 'match.join', role: 'talk' });
  await t2.next('match.waiting');
  hws.send({ type: 'match.join', role: 'listen' });
  await t2.next('match.found');
  await wait(300);
  assert.equal(sent.filter((p) => p.payload.tag === 'listener-needed').length, 0);

  // The original talker waits again: the online listener sees the banner instead, the blocked one is skipped.
  tws.send({ type: 'match.join', role: 'talk' });
  await tws.next('match.waiting');
  await wait(400);
  assert.equal(sent.filter((p) => p.payload.tag === 'listener-needed').length, 0);
  for (const w of [tws, t2, hws, onlineWs]) await w.close();
});

test('the on-call switch validates input and needs push configured', async (t) => {
  const { s } = await setup(t);
  const a = await signedUp(s.base);
  assert.equal((await a('POST', '/api/account/listener-alerts', { on: 'yes' })).status, 400);
  assert.equal((await a('POST', '/api/account/listener-alerts', { on: false })).status, 200);

  const off = await start({ push: createPush({ publicKey: '', privateKey: '' }) });
  t.after(off.stop);
  const b = await signedUp(off.base);
  assert.equal((await b('POST', '/api/account/listener-alerts', { on: true })).status, 503);
});
