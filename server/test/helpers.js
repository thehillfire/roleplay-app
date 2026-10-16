const WebSocket = require('ws');
const { boot } = require('../src/boot');

// Starts a full server on a random port: in-memory SQLite, or Postgres when
// TEST_DATABASE_URL is set (npm run test:pg).
async function start(options = {}) {
  const url = process.env.TEST_DATABASE_URL || '';
  const built = await boot({ db: { url, sqliteFile: ':memory:' }, realtime: { sweepMs: 50, ...options.realtime }, ...options });
  if (url) await built.db.query('TRUNCATE users, sessions, conversations, messages, blocks, reports, connections, payments, push_subscriptions, feedback, password_resets CASCADE');
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
function client(base) {
  let cookie = '';
  const api = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    return { status: res.status, body: await res.json(), setCookie: set };
  };
  api.cookie = () => cookie;
  api.socket = (headers = {}) => connect(base, { Cookie: cookie, ...headers });
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

async function signedUp(base, overrides) {
  const api = client(base);
  const res = await api('POST', '/api/auth/signup', adult(overrides));
  if (res.status !== 201) throw new Error(`signup failed: ${JSON.stringify(res.body)}`);
  api.user = res.body.user;
  return api;
}

module.exports = { start, client, connect, adult, signedUp };
