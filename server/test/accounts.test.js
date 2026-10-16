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
