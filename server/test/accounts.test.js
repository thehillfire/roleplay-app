const test = require('node:test');
const assert = require('node:assert/strict');
const { start, client, adult } = require('./helpers');
const { hashPassword, verifyPassword } = require('../src/auth');
const { ageOn } = require('../src/validate');

test('passwords are salted scrypt hashes that verify', async () => {
  const a = await hashPassword('secret-pass');
  const b = await hashPassword('secret-pass');
  assert.notEqual(a, b);
  assert.ok(a.startsWith('scrypt$'));
  assert.equal(await verifyPassword('secret-pass', a), true);
  assert.equal(await verifyPassword('wrong-pass', a), false);
  assert.equal(await verifyPassword('anything', undefined), false);
});

test('ageOn counts whole years and rejects impossible dates', () => {
  const today = new Date(Date.UTC(2026, 9, 16));
  assert.equal(ageOn('2008-10-16', today), 18);
  assert.equal(ageOn('2008-10-17', today), 17);
  assert.equal(ageOn('2008-02-30', today), NaN);
  assert.equal(ageOn('16/10/2008', today), NaN);
});

test('signup gives an anonymous handle and a session', async (t) => {
  const s = await start();
  t.after(s.stop);
  const api = client(s.base);
  const res = await api('POST', '/api/auth/signup', adult({ email: 'Jav@Example.com' }));
  assert.equal(res.status, 201);
  assert.match(res.body.user.handle, /^[A-Z][a-z]+[A-Z][a-z]+\d{2}$/);
  assert.ok(!('email' in res.body.user), 'email is never sent back to the client');
  assert.equal(res.body.user.status, 'active');
  assert.match(res.setCookie, /HttpOnly/);
  assert.match(res.setCookie, /SameSite=Lax/);
  const me = await api('GET', '/api/auth/me');
  assert.equal(me.body.user.handle, res.body.user.handle);
});

test('signup is adults only and requires agreeing to the guidelines', async (t) => {
  const s = await start();
  t.after(s.stop);
  const api = client(s.base);
  const minor = await api('POST', '/api/auth/signup', adult({ birthdate: `${new Date().getUTCFullYear() - 15}-01-01` }));
  assert.equal(minor.status, 403);
  assert.match(minor.body.error, /18/);
  assert.equal((await api('POST', '/api/auth/signup', adult({ birthdate: 'soon' }))).status, 400);
  assert.equal((await api('POST', '/api/auth/signup', adult({ agree: false }))).status, 400);
  assert.equal((await api('POST', '/api/auth/signup', adult({ password: 'short' }))).status, 400);
  assert.equal((await api('GET', '/api/auth/me')).body.user, null);
});

test('log out, wrong password, log back in, duplicate email', async (t) => {
  const s = await start();
  t.after(s.stop);
  const api = client(s.base);
  const creds = adult();
  await api('POST', '/api/auth/signup', creds);
  await api('POST', '/api/auth/logout', {});
  assert.equal((await api('GET', '/api/auth/me')).body.user, null);
  assert.equal((await api('POST', '/api/auth/login', { email: creds.email, password: 'nope' })).status, 401);
  const unknown = await api('POST', '/api/auth/login', { email: 'ghost@example.com', password: 'nope' });
  assert.equal(unknown.body.error, 'Email or password is incorrect.');
  assert.equal((await api('POST', '/api/auth/login', { email: creds.email.toUpperCase(), password: creds.password })).status, 200);
  assert.equal((await client(s.base)('POST', '/api/auth/signup', adult({ email: creds.email }))).status, 409);
});

test('logged-out session tokens stop working', async (t) => {
  const s = await start();
  t.after(s.stop);
  const api = client(s.base);
  await api('POST', '/api/auth/signup', adult());
  const cookie = api.cookie();
  await api('POST', '/api/auth/logout', {});
  const me = await fetch(`${s.base}/api/auth/me`, { headers: { Cookie: cookie } }).then((r) => r.json());
  assert.equal(me.user, null);
});

test('auth endpoints are rate limited per IP', async (t) => {
  const s = await start({ authRateLimit: { max: 2, windowMs: 60000 } });
  t.after(s.stop);
  const api = client(s.base);
  const bad = { email: 'a@b.co', password: 'x' };
  assert.equal((await api('POST', '/api/auth/login', bad)).status, 401);
  assert.equal((await api('POST', '/api/auth/login', bad)).status, 401);
  assert.equal((await api('POST', '/api/auth/login', bad)).status, 429);
});

test('mutating API calls must be JSON (CSRF guard)', async (t) => {
  const s = await start();
  t.after(s.stop);
  const res = await fetch(`${s.base}/api/auth/logout`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'a=1',
  });
  assert.equal(res.status, 415);
});

test('an account locks after 10 wrong passwords, whatever the IP', async (t) => {
  const s = await start({ authRateLimit: { max: 1000, windowMs: 60000 } });
  t.after(s.stop);
  const creds = adult();
  await client(s.base)('POST', '/api/auth/signup', creds);
  for (let i = 0; i < 10; i += 1) {
    const res = await fetch(`${s.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.9.0.${i}` },
      body: JSON.stringify({ email: creds.email, password: 'wrong-guess' }),
    });
    assert.equal(res.status, 401);
  }
  const locked = await client(s.base)('POST', '/api/auth/login', { email: creds.email, password: creds.password });
  assert.equal(locked.status, 429, 'even the right password waits out the lock');
  assert.match(locked.body.error, /Too many attempts/);
  const other = await client(s.base)('POST', '/api/auth/signup', adult());
  assert.equal(other.status, 201, 'other accounts unaffected');
});

test('health fails when the database is down', async (t) => {
  const s = await start();
  t.after(() => new Promise((r) => { s.server.realtime.close(); s.server.closeAllConnections?.(); s.server.close(r); }));
  assert.equal((await fetch(`${s.base}/api/health`)).status, 200);
  await s.db.close();
  const res = await fetch(`${s.base}/api/health`);
  assert.equal(res.status, 503);
});

test('sign out everywhere ends every session', async (t) => {
  const s = await start();
  t.after(s.stop);
  const creds = adult();
  const phone = client(s.base);
  await phone('POST', '/api/auth/signup', creds);
  const laptop = client(s.base);
  await laptop('POST', '/api/auth/login', { email: creds.email, password: creds.password });
  assert.ok((await laptop('GET', '/api/auth/me')).body.user);
  assert.equal((await phone('POST', '/api/auth/logout-all', {})).status, 200);
  assert.equal((await laptop('GET', '/api/auth/me')).body.user, null);
  assert.equal((await phone('GET', '/api/auth/me')).body.user, null);
});

test('a password reset lifts the account lockout', async (t) => {
  const sent = [];
  const s = await start({ authRateLimit: { max: 1000, windowMs: 60000 }, mailer: { enabled: true, send: async (m) => { sent.push(m); } } });
  t.after(s.stop);
  const creds = adult();
  await client(s.base)('POST', '/api/auth/signup', creds);
  for (let i = 0; i < 10; i += 1) await client(s.base)('POST', '/api/auth/login', { email: creds.email, password: 'nope' });
  assert.equal((await client(s.base)('POST', '/api/auth/login', { email: creds.email, password: creds.password })).status, 429);
  await client(s.base)('POST', '/api/auth/forgot', { email: creds.email });
  await new Promise((r) => setTimeout(r, 20));
  const token = sent.find((m) => /Reset/.test(m.subject)).text.match(/reset#([\w-]+)/)[1];
  await client(s.base)('POST', '/api/auth/reset', { token, password: 'brand-new-pass' });
  assert.equal((await client(s.base)('POST', '/api/auth/login', { email: creds.email, password: 'brand-new-pass' })).status, 200);
});

test('reset emails: at most one per address every 2 minutes, whatever IP asks', async (t) => {
  const sent = [];
  const s = await start({ authRateLimit: { max: 1000, windowMs: 60000 }, publicUrl: 'https://kindred.example', mailer: { enabled: true, send: async (m) => { sent.push(m); } } });
  t.after(s.stop);
  assert.equal((await client(s.base)('POST', '/api/auth/signup', adult({ email: 'victim@example.com' }))).status, 201);
  const attacker = client(s.base);
  for (let i = 0; i < 5; i += 1) assert.equal((await attacker('POST', '/api/auth/forgot', { email: 'victim@example.com' })).status, 200);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.filter((m) => m.to === 'victim@example.com' && m.subject === 'Reset your Kindred password').length, 1);
});

test('TRUST_PROXY=0: a faked X-Forwarded-For does not get a fresh rate-limit bucket', async (t) => {
  const s = await start({ trustProxy: 0, authRateLimit: { max: 2, windowMs: 60000 } });
  t.after(s.stop);
  const statuses = [];
  for (let i = 0; i < 4; i += 1) {
    const res = await fetch(`${s.base}/api/auth/forgot`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.9.9.${i}` }, body: JSON.stringify({ email: 'x@example.com' }) });
    statuses.push(res.status);
  }
  assert.deepEqual(statuses, [200, 200, 429, 429]);
});

test('signup refuses the most common passwords', async (t) => {
  const s = await start({ authRateLimit: { max: 1000, windowMs: 60000 } });
  t.after(s.stop);
  for (const password of ['password', '12345678', 'Password123']) {
    const res = await client(s.base)('POST', '/api/auth/signup', adult({ password }));
    assert.equal(res.status, 400, password);
    assert.match(res.body.error, /too easy to guess/);
  }
  const named = await client(s.base)('POST', '/api/auth/signup', adult({ email: 'riverstone@example.com', password: 'riverstone' }));
  assert.equal(named.status, 400, 'not the email name either');
});

test('sessions slide: using the app keeps you signed in; a lapsed session still ends', async (t) => {
  const s = await start();
  t.after(s.stop);
  const { SESSION_TTL_MS } = require('../src/auth');
  const creds = adult();
  const phone = client(s.base);
  await phone('POST', '/api/auth/signup', creds);
  const expiry = async () => Number((await s.db.query('SELECT expires_at FROM sessions')).rows[0].expires_at);

  // A fresh session isn't rewritten on every request.
  const first = await expiry();
  await phone('GET', '/api/auth/me');
  assert.equal(await expiry(), first, 'no write within the first day');

  // Ten days later (as if): the next visit pushes it back out to the full length.
  await s.db.query('UPDATE sessions SET expires_at = $1', [Date.now() + SESSION_TTL_MS - 10 * 24 * 60 * 60 * 1000]);
  const res = await fetch(`${s.base}/api/auth/me`, { headers: { cookie: phone.cookie() } });
  assert.match(res.headers.get('set-cookie') || '', /lf_sid=.*Max-Age=15552000/, 'cookie renewed for 180 days');
  assert.ok(await expiry() > Date.now() + SESSION_TTL_MS - 60000, 'renewed in the database too');

  // A session that already lapsed is gone, renewal or not.
  await s.db.query('UPDATE sessions SET expires_at = $1', [Date.now() - 1000]);
  assert.equal((await phone('GET', '/api/auth/me')).body.user, null);
});
