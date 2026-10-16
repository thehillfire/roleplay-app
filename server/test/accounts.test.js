const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('../src/boot');
const { createOfflineNarrator } = require('../src/narrator');
const { hashPassword, verifyPassword } = require('../src/auth');

// Runs on in-memory SQLite, or on Postgres when TEST_DATABASE_URL is set (npm run test:pg).
async function start(options = {}) {
  const url = process.env.TEST_DATABASE_URL || '';
  const { app, db } = await boot({ db: { url, sqliteFile: ':memory:' }, narrator: createOfflineNarrator(), ...options });
  if (url) await db.query('TRUNCATE users, sessions, stories CASCADE');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, db, stop: () => new Promise((r) => server.close(r)).then(() => db.close()) };
}

// A minimal client that keeps one session cookie, like a browser tab.
function client(base) {
  let cookie = '';
  return async (method, path, body) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    return { status: res.status, body: await res.json(), setCookie: set };
  };
}

const hero = { name: 'Moss Warden', rarity: 'Rare', description: 'Keeps the old forest.', theme: 'moss', role: 'warden' };
const signup = { email: 'Jav@Example.com', password: 'correct horse', displayName: 'Jav' };

test('passwords are salted scrypt hashes that verify', async () => {
  const a = await hashPassword('secret-pass');
  const b = await hashPassword('secret-pass');
  assert.notEqual(a, b);
  assert.ok(a.startsWith('scrypt$'));
  assert.equal(await verifyPassword('secret-pass', a), true);
  assert.equal(await verifyPassword('wrong-pass', a), false);
  assert.equal(await verifyPassword('anything', undefined), false);
});

test('sign up, me, log out, log in', async (t) => {
  const s = await start();
  t.after(s.stop);
  const api = client(s.base);

  const created = await api('POST', '/api/auth/signup', signup);
  assert.equal(created.status, 201);
  assert.equal(created.body.user.email, 'jav@example.com');
  assert.ok(!('passwordHash' in created.body.user));
  assert.match(created.setCookie, /HttpOnly/);
  assert.match(created.setCookie, /SameSite=Lax/);

  assert.equal((await api('GET', '/api/auth/me')).body.user.displayName, 'Jav');
  await api('POST', '/api/auth/logout', {});
  assert.equal((await api('GET', '/api/auth/me')).body.user, null);

  assert.equal((await api('POST', '/api/auth/login', { email: 'jav@example.com', password: 'nope' })).status, 401);
  const unknown = await api('POST', '/api/auth/login', { email: 'ghost@example.com', password: 'nope' });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.body.error, 'Email or password is incorrect.');

  const login = await api('POST', '/api/auth/login', { email: 'JAV@example.com', password: 'correct horse' });
  assert.equal(login.status, 200);
  assert.equal((await api('GET', '/api/auth/me')).body.user.email, 'jav@example.com');
});

test('signup validates input and rejects duplicate emails', async (t) => {
  const s = await start();
  t.after(s.stop);
  const api = client(s.base);
  assert.equal((await api('POST', '/api/auth/signup', { ...signup, password: 'short' })).status, 400);
  assert.equal((await api('POST', '/api/auth/signup', { ...signup, email: 'not-an-email' })).status, 400);
  assert.equal((await api('POST', '/api/auth/signup', { ...signup, displayName: '' })).status, 400);
  assert.equal((await api('POST', '/api/auth/signup', signup)).status, 201);
  const dup = await api('POST', '/api/auth/signup', { ...signup, email: 'jav@example.com' });
  assert.equal(dup.status, 409);
});

test('logged-out session tokens stop working', async (t) => {
  const s = await start();
  t.after(s.stop);
  const res = await fetch(`${s.base}/api/auth/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(signup),
  });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const me = () => fetch(`${s.base}/api/auth/me`, { headers: { Cookie: cookie } }).then((r) => r.json());
  assert.ok((await me()).user);
  await fetch(`${s.base}/api/auth/logout`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}' });
  assert.equal((await me()).user, null);
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

test('saved stories: create, play, list, reload, delete', async (t) => {
  const s = await start();
  t.after(s.stop);
  const api = client(s.base);

  assert.equal((await api('GET', '/api/stories')).status, 401);
  await api('POST', '/api/auth/signup', signup);

  const created = await api('POST', '/api/stories', { hero });
  assert.equal(created.status, 201);
  const story = created.body.story;
  assert.equal(story.history.length, 1);
  assert.equal(story.history[0].role, 'narrator');
  assert.equal(story.version, 0);

  const turn = await api('POST', `/api/stories/${story.id}/turns`, { action: 'Listen to the trees', version: 0 });
  assert.equal(turn.status, 200);
  assert.equal(turn.body.story.history.length, 3);
  assert.equal(turn.body.story.version, 1);

  const stale = await api('POST', `/api/stories/${story.id}/turns`, { action: 'Again', version: 0 });
  assert.equal(stale.status, 409);

  const list = await api('GET', '/api/stories');
  assert.equal(list.body.stories.length, 1);
  assert.equal(list.body.stories[0].actions, 1);
  assert.equal(list.body.stories[0].hero.name, 'Moss Warden');
  assert.ok(!('history' in list.body.stories[0]));

  const fetched = await api('GET', `/api/stories/${story.id}`);
  assert.equal(fetched.body.story.history[1].text, 'Listen to the trees');

  assert.equal((await api('DELETE', `/api/stories/${story.id}`)).status, 200);
  assert.equal((await api('GET', `/api/stories/${story.id}`)).status, 404);
});

test("players can't see or change each other's stories", async (t) => {
  const s = await start();
  t.after(s.stop);
  const alice = client(s.base);
  const bob = client(s.base);
  await alice('POST', '/api/auth/signup', { ...signup, email: 'alice@example.com' });
  await bob('POST', '/api/auth/signup', { ...signup, email: 'bob@example.com' });
  const { story } = (await alice('POST', '/api/stories', { hero })).body;

  assert.equal((await bob('GET', `/api/stories/${story.id}`)).status, 404);
  assert.equal((await bob('POST', `/api/stories/${story.id}/turns`, { action: 'Steal' })).status, 404);
  assert.equal((await bob('DELETE', `/api/stories/${story.id}`)).status, 404);
  assert.equal((await bob('GET', '/api/stories')).body.stories.length, 0);
  assert.equal((await alice('GET', `/api/stories/${story.id}`)).status, 200);
});

test('guest stories can be imported into an account', async (t) => {
  const s = await start();
  t.after(s.stop);
  const api = client(s.base);
  await api('POST', '/api/auth/signup', signup);

  const guest = {
    hero,
    history: [{ role: 'narrator', text: 'Once.' }, { role: 'player', text: 'Wave' }, { role: 'narrator', text: 'Twice.' }],
    choices: ['Walk on'],
    createdAt: 1000,
  };
  const res = await api('POST', '/api/stories/import', { stories: [guest] });
  assert.equal(res.status, 201);
  assert.equal(res.body.imported, 1);
  const list = (await api('GET', '/api/stories')).body.stories;
  assert.equal(list[0].actions, 1);
  assert.equal(list[0].createdAt, 1000);

  const bad = await api('POST', '/api/stories/import', { stories: [{ hero, history: [] }] });
  assert.equal(bad.status, 400);
  assert.equal((await api('GET', '/api/stories')).body.stories.length, 1, 'a failed import adds nothing');
});

test('turn input is validated', async (t) => {
  const s = await start();
  t.after(s.stop);
  const api = client(s.base);
  await api('POST', '/api/auth/signup', signup);
  const { story } = (await api('POST', '/api/stories', { hero })).body;
  assert.equal((await api('POST', `/api/stories/${story.id}/turns`, {})).status, 400);
  assert.equal((await api('POST', `/api/stories/${story.id}/turns`, { action: 'x'.repeat(301) })).status, 400);
  assert.equal((await api('POST', '/api/stories', { hero: { name: '' } })).status, 400);
});
