const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helpers');
const { createErrorAlerts } = require('../src/alerts');

test('server errors post a short, rate-limited alert without request data', async (t) => {
  const posted = [];
  let clock = 1_000_000;
  const alerts = createErrorAlerts({ url: 'https://hooks.example/abc', now: () => clock, fetchImpl: async (url, init) => { posted.push(JSON.parse(init.body)); return { ok: true }; } });
  const s = await start({ errorAlerts: alerts });
  t.after(s.stop);
  // Make one route fail like a real bug would.
  s.store.listConversations = async () => { throw new Error('connection terminated unexpectedly'); };
  const { signedUp } = require('./helpers');
  const a = await signedUp(s.base);
  for (let i = 0; i < 3; i += 1) assert.equal((await a('GET', '/api/conversations')).status, 500);
  assert.equal(posted.length, 1, 'the same error once per 10 minutes');
  assert.equal(posted[0].text, 'Kindred server error on GET /api/conversations: Error: connection terminated unexpectedly');
  assert.equal(posted[0].content, posted[0].text, 'Discord-compatible too');
  clock += 11 * 60 * 1000;
  await a('GET', '/api/conversations');
  assert.equal(posted.length, 2);
});

test('error alerts are off without an https webhook URL', () => {
  assert.equal(createErrorAlerts({ url: '' }).enabled, false);
  assert.equal(createErrorAlerts({ url: 'http://insecure.example' }).enabled, false);
});

test('a crash on a phone is logged and alerted, rate-limited, with nothing but the error text', async (t) => {
  const posted = [];
  const alerts = createErrorAlerts({ url: 'https://hooks.example/abc', fetchImpl: async (url, init) => { posted.push(JSON.parse(init.body)); return { ok: true }; } });
  const s = await start({ errorAlerts: alerts });
  t.after(s.stop);
  const logged = [];
  const real = console.error;
  console.error = (...a) => logged.push(a.join(' '));
  t.after(() => { console.error = real; });
  const send = (body) => fetch(`${s.base}/api/client-error`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await send({ message: "Cannot read properties of undefined (reading 'tag')", stack: 'at Home\nat App', where: '/' })).status, 204);
  assert.match(logged[0], /\[client error\] Cannot read properties of undefined \(reading 'tag'\) @ \/ :: at Home \| at App/);
  assert.equal(posted[0].text, "Kindred server error on client /: ClientError: Cannot read properties of undefined (reading 'tag')");
  assert.equal((await send({})).status, 204, 'nothing to log is fine');
  for (let i = 0; i < 4; i += 1) await send({ message: `x${i}` });
  assert.equal((await send({ message: 'one too many' })).status, 429);
});
