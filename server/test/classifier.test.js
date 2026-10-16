const test = require('node:test');
const assert = require('node:assert/strict');
const { createClassifier } = require('../src/classifier');
const { start, signedUp } = require('./helpers');

const quiet = { warn: () => {} };
const respond = (categories, scores = {}) => async () => ({
  ok: true,
  json: async () => ({ results: [{ flagged: true, categories, category_scores: scores }] }),
});

test('off unless configured', async () => {
  assert.equal(createClassifier({ provider: undefined, apiKey: 'k' }).enabled, false);
  assert.equal(createClassifier({ provider: 'openai', apiKey: '' }).enabled, false);
});

test('maps categories with thresholds that tolerate venting', async () => {
  const c = (cats, scores) => createClassifier({ provider: 'openai', apiKey: 'k', fetchImpl: respond(cats, scores), log: quiet }).classify('x');
  assert.deepEqual(await c({ 'harassment/threatening': true }, { 'harassment/threatening': 0.8 }), { flags: ['threat'], crisis: false });
  assert.deepEqual(await c({ harassment: true }, { harassment: 0.6 }), { flags: [], crisis: false }, 'angry venting at 0.6 passes');
  assert.deepEqual(await c({ harassment: true }, { harassment: 0.95 }), { flags: ['harassment'], crisis: false });
  assert.deepEqual(await c({ 'sexual/minors': true }, { 'sexual/minors': 0.2 }), { flags: ['minor_sexual'], crisis: false });
  assert.deepEqual(await c({ 'self-harm/intent': true }, {}), { flags: [], crisis: true });
});

test('fails open when the service is down or slow', async () => {
  const down = createClassifier({ provider: 'openai', apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 503 }), log: quiet });
  assert.equal(await down.classify('x'), null);
  const slow = createClassifier({ provider: 'openai', apiKey: 'k', timeoutMs: 20, log: quiet, fetchImpl: (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('timeout')))) });
  // AbortSignal.timeout doesn't hold the event loop open; a real server always has other work.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    assert.equal(await slow.classify('x'), null);
  } finally {
    clearInterval(keepAlive);
  }
});

test('classifier verdicts hold messages the rules let through', async (t) => {
  let next = null;
  const classifier = { enabled: true, classify: async () => next };
  const s = await start({ classifier });
  t.after(s.stop);
  const alice = await signedUp(s.base);
  const bob = await signedUp(s.base);
  const aws = await alice.socket();
  const bws = await bob.socket();
  t.after(() => Promise.all([aws.close(), bws.close()]));
  aws.send({ type: 'match.join', role: 'talk' });
  await aws.next('match.waiting');
  bws.send({ type: 'match.join', role: 'listen' });
  const { conversationId: id } = await aws.next('match.found');

  next = { flags: ['threat'], crisis: false };
  const held = await alice('POST', `/api/conversations/${id}/messages`, { body: 'you will regret this' });
  assert.equal(held.body.message.status, 'held');
  assert.deepEqual(held.body.message.flags, ['threat']);

  next = null; // service down: rules alone decide
  const ok = await alice('POST', `/api/conversations/${id}/messages`, { body: 'sorry, bad day' });
  assert.equal(ok.body.message.status, 'delivered');

  next = { flags: [], crisis: true };
  const crisis = await alice('POST', `/api/conversations/${id}/messages`, { body: 'I cannot keep going like this' });
  assert.equal(crisis.body.crisis, true);
  assert.equal(crisis.body.message.status, 'delivered');
});
