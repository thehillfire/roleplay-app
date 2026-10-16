const test = require('node:test');
const assert = require('node:assert/strict');
const { start, signedUp } = require('./helpers');
const { createPush } = require('../src/push');

const sub = (n) => ({ endpoint: `https://push.example.com/send/${n}`, keys: { p256dh: 'BPk-key', auth: 'auth-secret' } });

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
  await new Promise((r) => setTimeout(r, 30));
  const bobId = (await s.db.query('SELECT id FROM users WHERE handle = $1', [bob.user.handle])).rows[0].id;
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
