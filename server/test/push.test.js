const test = require('node:test');
const assert = require('node:assert/strict');
const { start, signedUp } = require('./helpers');
const { createPush } = require('../src/push');

const sub = (n) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, keys: { p256dh: 'BPk-key', auth: 'auth-secret' } });

test('offline partners get a push with the handle but never the message text', async (t) => {
  const sent = [];
  let failNext = 0;
  const push = createPush({
    publicKey: 'pub', privateKey: 'priv',
    sendImpl: async (subscription, payload) => {
      if (failNext) { failNext -= 1; throw Object.assign(new Error('gone'), { statusCode: 410 }); }
      sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) });
    },
  });
  const s = await start({ push });
  t.after(s.stop);
  const alice = await signedUp(s.base);
  const bob = await signedUp(s.base);

  assert.equal((await bob('GET', '/api/auth/me')).body.push.publicKey, 'pub');
  assert.equal((await bob('POST', '/api/push/subscribe', { subscription: { endpoint: 'http://insecure', keys: {} } })).status, 400);
  assert.equal((await bob('POST', '/api/push/subscribe', { subscription: sub(1) })).status, 201);

  // Match while both are online, then Bob closes the app.
  const aws = await alice.socket();
  const bws = await bob.socket();
  aws.send({ type: 'match.join', role: 'talk' });
  await aws.next('match.waiting');
  bws.send({ type: 'match.join', role: 'listen' });
  const { conversationId: id } = await aws.next('match.found');
  await alice('POST', `/api/conversations/${id}/messages`, { body: 'are you there? (online, no push)' });
  assert.equal(sent.length, 0, 'no push while their app is open');
  await bws.close();
  await new Promise((r) => setTimeout(r, 30));

  await alice('POST', `/api/conversations/${id}/messages`, { body: 'my secret worry' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].payload, { title: 'Kindred', body: `New message from ${alice.user.handle}`, conversationId: id, tag: id });
  assert.ok(!JSON.stringify(sent[0].payload).includes('secret'), 'message text never leaves in a push');

  // A subscription the push service reports gone is removed.
  failNext = 1;
  await alice('POST', `/api/conversations/${id}/messages`, { body: 'hello again' });
  const bobId = (await s.db.query('SELECT id FROM users WHERE handle = $1', [bob.user.handle])).rows[0].id;
  // The removal happens after the response, in the background: wait for it rather than a fixed delay.
  for (let i = 0; i < 100 && (await s.store.pushSubscriptions(bobId)).length; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(await s.store.pushSubscriptions(bobId), []);
  await aws.close();
});

test('push endpoints are off when VAPID keys are missing', async (t) => {
  const s = await start({ push: createPush({ publicKey: '', privateKey: '' }) });
  t.after(s.stop);
  const alice = await signedUp(s.base);
  assert.equal((await alice('GET', '/api/auth/me')).body.push.publicKey, null);
  assert.equal((await alice('POST', '/api/push/subscribe', { subscription: sub(2) })).status, 503);
});

test('a muted conversation sends no push, but messages still arrive', async (t) => {
  const sent = [];
  const push = createPush({ publicKey: 'pub', privateKey: 'priv', sendImpl: async (subscription, payload) => { sent.push(JSON.parse(payload)); } });
  const s = await start({ push });
  t.after(s.stop);
  const alice = await signedUp(s.base);
  const bob = await signedUp(s.base);
  await bob('POST', '/api/push/subscribe', { subscription: sub(3) });
  const aws = await alice.socket();
  const bws = await bob.socket();
  aws.send({ type: 'match.join', role: 'talk' });
  await aws.next('match.waiting');
  bws.send({ type: 'match.join', role: 'listen' });
  const { conversationId: id } = await aws.next('match.found');
  assert.equal((await bob('POST', `/api/conversations/${id}/mute`, { muted: 'yes' })).status, 400);
  assert.deepEqual((await bob('POST', `/api/conversations/${id}/mute`, { muted: true })).body, { muted: true });
  assert.equal((await bob('GET', `/api/conversations/${id}`)).body.conversation.muted, true);
  assert.equal((await alice('GET', `/api/conversations/${id}`)).body.conversation.muted, false, 'only for Bob');
  await bws.close();
  await new Promise((r) => setTimeout(r, 30));

  await alice('POST', `/api/conversations/${id}/messages`, { body: 'are you around?' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sent.length, 0, 'muted: no push');
  assert.equal((await bob('GET', '/api/conversations')).body.conversations[0].unread, 1, 'still delivered');

  await bob('POST', `/api/conversations/${id}/mute`, { muted: false });
  await alice('POST', `/api/conversations/${id}/messages`, { body: 'hello again' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sent.length, 1);
  await aws.close();
});

test('push subscriptions must point at a real push service', async (t) => {
  const push = createPush({ publicKey: 'pub', privateKey: 'priv', sendImpl: async () => {} });
  const s = await start({ push });
  t.after(s.stop);
  const a = await signedUp(s.base);
  const keys = { p256dh: 'BPk-key', auth: 'auth-secret' };
  for (const endpoint of ['https://169.254.169.254/latest/meta-data', 'https://evil.example/collect', 'https://fcm.googleapis.com.evil.example/x']) {
    assert.equal((await a('POST', '/api/push/subscribe', { subscription: { endpoint, keys } })).status, 400, endpoint);
  }
  for (const endpoint of ['https://fcm.googleapis.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/abc', 'https://web.push.apple.com/abc']) {
    assert.equal((await a('POST', '/api/push/subscribe', { subscription: { endpoint, keys } })).status, 201, endpoint);
  }
});

test('a push subscription saved before the allowlist is dropped instead of used', async (t) => {
  const sent = [];
  const push = createPush({ publicKey: 'pub', privateKey: 'priv', sendImpl: async (subscription) => { sent.push(subscription.endpoint); } });
  const s = await start({ push });
  t.after(s.stop);
  const alice = await signedUp(s.base);
  const bob = await signedUp(s.base);
  const bobId = (await s.db.query('SELECT id FROM users WHERE handle = $1', [bob.user.handle])).rows[0].id;
  await s.store.savePushSubscription(bobId, { endpoint: 'https://169.254.169.254/old', keys: { p256dh: 'k', auth: 'a' } });
  const aws = await alice.socket();
  const bws = await bob.socket();
  aws.send({ type: 'match.join', role: 'talk' });
  await aws.next('match.waiting');
  bws.send({ type: 'match.join', role: 'listen' });
  const { conversationId } = await aws.next('match.found');
  await bws.close();
  await new Promise((r) => setTimeout(r, 30));
  await alice('POST', `/api/conversations/${conversationId}/messages`, { body: 'hello?' });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(sent, []);
  assert.deepEqual(await s.store.pushSubscriptions(bobId), []);
  await aws.close();
});
