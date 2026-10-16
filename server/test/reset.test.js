const test = require('node:test');
const assert = require('node:assert/strict');
const { start, signedUp, client } = require('./helpers');

function fakeMailer() {
  const sent = [];
  return { sent, enabled: true, send: async (mail) => { sent.push(mail); } };
}
const tokenFrom = (mail) => mail.text.match(/\/reset#([A-Za-z0-9_-]+)/)[1];
const resets = (mailer) => mailer.sent.filter((m) => /Reset your/.test(m.subject));

test('forgot password emails a single-use link that resets and signs out old sessions', async (t) => {
  const mailer = fakeMailer();
  const s = await start({ mailer, publicUrl: 'https://kindred.example' });
  t.after(s.stop);
  const alice = await signedUp(s.base, { email: 'alice-reset@example.com' });
  const anon = client(s.base);

  const unknown = await anon('POST', '/api/auth/forgot', { email: 'nobody@example.com' });
  assert.deepEqual(unknown.body, { ok: true }, 'same answer for unknown emails');
  assert.equal(resets(mailer).length, 0);

  assert.deepEqual((await anon('POST', '/api/auth/forgot', { email: 'Alice-Reset@example.com' })).body, { ok: true });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(resets(mailer).length, 1);
  assert.equal(resets(mailer)[0].to, 'alice-reset@example.com');
  assert.match(resets(mailer)[0].text, /^.*https:\/\/kindred\.example\/reset#/m);
  const token = tokenFrom(resets(mailer)[0]);

  assert.equal((await anon('POST', '/api/auth/reset', { token, password: 'short' })).status, 400);
  assert.equal((await anon('POST', '/api/auth/reset', { token: 'nope', password: 'brand-new-pass' })).status, 400);
  const reset = await anon('POST', '/api/auth/reset', { token, password: 'brand-new-pass' });
  assert.equal(reset.status, 200);
  assert.equal((await anon('GET', '/api/auth/me')).body.user.handle, alice.user.handle, 'signed in after reset');

  assert.equal((await alice('GET', '/api/auth/me')).body.user, null, 'old sessions were signed out');
  assert.equal((await anon('POST', '/api/auth/reset', { token, password: 'another-pass-1' })).status, 400, 'single use');
  assert.equal((await client(s.base)('POST', '/api/auth/login', { email: 'alice-reset@example.com', password: 'quiet-harbor-9' })).status, 401);
  assert.equal((await client(s.base)('POST', '/api/auth/login', { email: 'alice-reset@example.com', password: 'brand-new-pass' })).status, 200);
});

test('only the newest reset link works, and links expire', async (t) => {
  const mailer = fakeMailer();
  const clock = Date.now();
  const s = await start({ mailer, emailCooldownMs: 0 });
  t.after(s.stop);
  await signedUp(s.base, { email: 'bob-reset@example.com' });
  const anon = client(s.base);
  await anon('POST', '/api/auth/forgot', { email: 'bob-reset@example.com' });
  await anon('POST', '/api/auth/forgot', { email: 'bob-reset@example.com' });
  await new Promise((r) => setTimeout(r, 20));
  const [first, second] = resets(mailer).map(tokenFrom);
  assert.equal((await anon('POST', '/api/auth/reset', { token: first, password: 'brand-new-pass' })).status, 400);

  // Expire the remaining token by moving it into the past.
  await s.db.query('UPDATE password_resets SET expires_at = $1', [clock - 1]);
  assert.equal((await anon('POST', '/api/auth/reset', { token: second, password: 'brand-new-pass' })).status, 400);
});

test('in production without PUBLIC_URL, reset links are never built from the Host header', async (t) => {
  const mailer = fakeMailer();
  const s = await start({ mailer, allowHostFallback: false, publicUrl: '' });
  t.after(s.stop);
  await signedUp(s.base, { email: 'carol-reset@example.com' });
  const res = await fetch(`${s.base}/api/auth/forgot`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Host: 'evil.example' }, body: JSON.stringify({ email: 'carol-reset@example.com' }),
  });
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(mailer.sent.length, 0, 'no email (not even a verification one) without a trusted base URL');
});

test('a reset link stops working once the account is deleted', async (t) => {
  const mailer = fakeMailer();
  const s = await start({ mailer });
  t.after(s.stop);
  const dana = await signedUp(s.base, { email: 'dana-reset@example.com' });
  await client(s.base)('POST', '/api/auth/forgot', { email: 'dana-reset@example.com' });
  await new Promise((r) => setTimeout(r, 20));
  const token = tokenFrom(resets(mailer)[0]);
  await dana('POST', '/api/account/delete', { password: 'quiet-harbor-9' });
  const anon = client(s.base);
  assert.equal((await anon('POST', '/api/auth/reset', { token, password: 'brand-new-pass' })).status, 400);
  assert.equal((await anon('GET', '/api/auth/me')).body.user, null);
});
