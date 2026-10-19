const WebSocket = require('ws');
const { boot } = require('../src/boot');

// Starts a full server on a random port: in-memory SQLite, or Postgres when
// TEST_DATABASE_URL is set (npm run test:pg).
async function start(options = {}) {
  const url = process.env.TEST_DATABASE_URL || '';
  const built = await boot({ db: { url, sqliteFile: ':memory:' }, realtime: { sweepMs: 50, ...options.realtime }, ...options });
  if (url) await built.db.query('TRUNCATE users, sessions, conversations, messages, blocks, reports, connections, payments, push_subscriptions, feedback, password_resets, email_verifications, checkins, mod_actions, appeals, support_requests, user_devices, banned_devices, bottles, connect_asks, oauth_identities CASCADE');
  const server = built.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    ...built,
    base,
    server,
    stop: () => new Promise((r) => { server.realtime.close(); server.closeAllConnections?.(); server.close(r); }).then(() => built.db.close()),
  };
}

// A minimal browser-like client: keeps one session cookie, can open a socket.
function client(base, device) {
  const jar = new Map(); // name -> value, like a browser (session + device cookies)
  if (device) jar.set('kd_dev', device);
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const api = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(jar.size ? { Cookie: cookie() } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    absorb(res);
    const set = res.headers.get('set-cookie');
    return { status: res.status, body: await res.json(), setCookie: set };
  };
  const absorb = (res) => {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [name, ...rest] = pair.split('=');
      const value = rest.join('=');
      if (value) jar.set(name, value);
      else jar.delete(name);
    }
  };
  // For endpoints that answer with a redirect instead of JSON (the Google/Apple callback). Doesn't follow it.
  api.raw = async (method, path, { form, body } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      redirect: 'manual',
      headers: {
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(jar.size ? { Cookie: cookie() } : {}),
      },
      body: form ? new URLSearchParams(form) : body === undefined ? undefined : JSON.stringify(body),
    });
    absorb(res);
    return { status: res.status, location: res.headers.get('location'), setCookies: res.headers.getSetCookie() };
  };
  // Same browser, new person: keeps the device cookie, drops the session.
  api.device = () => jar.get('kd_dev');
  api.cookie = () => (jar.has('lf_sid') ? `lf_sid=${jar.get('lf_sid')}` : '');
  api.socket = (headers = {}) => connect(base, { Cookie: cookie(), ...headers });
  return api;
}

// Opens a WebSocket and collects events so tests can await specific ones.
function connect(base, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers });
    const events = [];
    const waiters = [];
    ws.on('message', (raw) => {
      const event = JSON.parse(raw);
      events.push(event);
      for (const w of [...waiters]) {
        if (w.match(event)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(event);
        }
      }
    });
    ws.once('open', () => resolve({
      ws,
      events,
      send: (event) => ws.send(JSON.stringify(event)),
      next(type, timeoutMs = 2000) {
        const found = events.find((e) => e.type === type && !e.seen);
        if (found) { found.seen = true; return Promise.resolve(found); }
        return new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error(`timed out waiting for ${type}`)), timeoutMs);
          waiters.push({ match: (e) => e.type === type, resolve: (e) => { clearTimeout(timer); e.seen = true; res(e); } });
        });
      },
      close: () => new Promise((r) => {
        if (ws.readyState === WebSocket.CLOSED) return r(); // the server may have closed it already
        ws.once('close', r);
        ws.close();
      }),
    }));
    ws.once('unexpected-response', (req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
    ws.once('error', reject);
  });
}

let counter = 0;
const adult = (overrides = {}) => ({
  email: `user${Date.now()}${counter++}@example.com`,
  password: 'quiet-harbor-9',
  birthdate: '1995-04-12',
  agree: true,
  ...overrides,
});

async function signedUp(base, overrides, { device } = {}) {
  const api = client(base, device);
  const res = await api('POST', '/api/auth/signup', adult(overrides));
  if (res.status !== 201) throw new Error(`signup failed: ${JSON.stringify(res.body)}`);
  api.user = res.body.user;
  return api;
}

module.exports = { start, client, connect, adult, signedUp };
