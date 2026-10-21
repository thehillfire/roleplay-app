// Rough load test: N simulated people sign up, match in pairs and exchange messages.
// Usage: node scripts/load-test.js [baseUrl] [people] [messagesEach]
const WebSocket = require('ws');

const BASE = process.argv[2] || 'http://localhost:3000';
const PEOPLE = Number(process.argv[3]) || 200;
const MESSAGES = Number(process.argv[4]) || 10;

const pct = (arr, p) => arr.sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))];

async function person(i) {
  let cookie = '';
  const api = async (method, path, body) => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), 'X-Forwarded-For': `10.0.${Math.floor(i / 250)}.${i % 250}` },
      body: body && JSON.stringify(body),
    });
    // Keep the session cookie (signup also sets a device cookie).
    const session = res.headers.getSetCookie().find((c) => c.startsWith('lf_sid='));
    if (session) cookie = session.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
  const signup = await api('POST', '/api/auth/signup', { email: `load${Date.now()}-${i}@example.com`, password: 'load-test-pass', birthdate: '1990-01-01', agree: true });
  if (signup.status !== 201) throw new Error(`signup ${signup.status} ${JSON.stringify(signup.body)}`);
  const ws = await new Promise((resolve, reject) => {
    const w = new WebSocket(`${BASE.replace('http', 'ws')}/ws`, { headers: { Cookie: cookie } });
    w.once('open', () => resolve(w));
    w.once('error', reject);
  });
  const events = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const e = JSON.parse(raw);
    const w = waiters.findIndex((x) => x.type === e.type);
    if (w >= 0) waiters.splice(w, 1)[0].resolve(e);
    else events.push(e);
  });
  const next = (type) => {
    const idx = events.findIndex((e) => e.type === type);
    if (idx >= 0) return Promise.resolve(events.splice(idx, 1)[0]);
    return new Promise((resolve) => waiters.push({ type, resolve }));
  };
  return { api, ws, next, i };
}

(async () => {
  console.log(`Load test: ${PEOPLE} people, ${MESSAGES} messages each, against ${BASE}`);
  const t0 = Date.now();
  const people = [];
  for (let i = 0; i < PEOPLE; i += 20) {
    people.push(...await Promise.all(Array.from({ length: Math.min(20, PEOPLE - i) }, (_, k) => person(i + k))));
  }
  const tSignup = Date.now();
  console.log(`signed up + connected: ${PEOPLE} in ${tSignup - t0} ms`);

  const matchStart = Date.now();
  const found = people.map((p) => p.next('match.found'));
  people.forEach((p, i) => p.ws.send(JSON.stringify({ type: 'match.join', role: i % 2 ? 'listen' : 'talk' })));
  const matches = await Promise.all(found);
  console.log(`all matched in ${Date.now() - matchStart} ms`);

  const latencies = [];
  const sendStart = Date.now();
  await Promise.all(people.map(async (p, idx) => {
    const convo = matches[idx].conversationId;
    for (let m = 0; m < MESSAGES; m += 1) {
      const t = Date.now();
      const r = await p.api('POST', `/api/conversations/${convo}/messages`, { body: `message ${m} from ${p.i}` });
      if (r.status !== 201) throw new Error(`send ${r.status} ${JSON.stringify(r.body)}`);
      latencies.push(Date.now() - t);
    }
  }));
  const total = PEOPLE * MESSAGES;
  const secs = (Date.now() - sendStart) / 1000;
  console.log(`sent ${total} messages in ${secs.toFixed(1)} s (${Math.round(total / secs)}/s); latency p50 ${pct(latencies, 0.5)} ms, p95 ${pct(latencies, 0.95)} ms, p99 ${pct(latencies, 0.99)} ms`);

  const listT = Date.now();
  await Promise.all(people.slice(0, 50).map((p) => p.api('GET', '/api/conversations')));
  console.log(`50 concurrent conversation-list loads: ${Date.now() - listT} ms`);
  people.forEach((p) => p.ws.close());
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
