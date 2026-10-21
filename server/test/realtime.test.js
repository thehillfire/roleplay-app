const test = require('node:test');
const assert = require('node:assert/strict');
const { start, signedUp } = require('./helpers');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('Cancel pressed while a join is still starting leaves you out of the queue', async (t) => {
  const s = await start();
  t.after(s.stop);
  const a = await signedUp(s.base);
  const ws = await a.socket();
  t.after(() => ws.close());
  ws.send({ type: 'match.join', role: 'talk' });
  ws.send({ type: 'match.leave' });
  await ws.next('match.left');
  await sleep(150);
  assert.equal(s.server.realtime.matchmaker.isQueued(a.user.id), false);
});

test('a suspended person is out of the queue at once, even if their phone never answers', async (t) => {
  const s = await start();
  t.after(s.stop);
  const a = await signedUp(s.base);
  const b = await signedUp(s.base);
  const sa = await a.socket();
  const sb = await b.socket();
  t.after(() => sb.close());
  sa.send({ type: 'match.join', role: 'talk' });
  await sa.next('match.waiting');
  sa.ws._socket.pause(); // never reads the close frame (asleep phone, bad network)
  const aId = (await s.db.query('SELECT id FROM users WHERE handle = $1', [a.user.handle])).rows[0].id;
  await s.store.setUserStatus(aId, 'suspended');
  s.hub.disconnect(aId);
  assert.equal(s.server.realtime.matchmaker.isQueued(aId), false);
  sb.send({ type: 'match.join', role: 'listen' });
  await sb.next('match.waiting');
  await sleep(100);
  assert.equal(sb.events.filter((e) => e.type === 'match.found').length, 0, 'not matched with a suspended account');
  sa.ws.terminate();
});

test('a failed match keeps the message left for the next listener', async (t) => {
  const s = await start();
  t.after(s.stop);
  const a = await signedUp(s.base);
  await a('POST', '/api/bottle', { body: 'Rough night. Anyone around?' });
  const b = await signedUp(s.base);
  const sa = await a.socket();
  const sb = await b.socket();
  t.after(() => Promise.all([sa.close(), sb.close()]));
  const real = s.store.openConversation;
  s.store.openConversation = async () => { throw new Error('database hiccup'); };
  sa.send({ type: 'match.join', role: 'talk' });
  await sa.next('match.waiting');
  sb.send({ type: 'match.join', role: 'listen' });
  await sa.next('match.error');
  s.store.openConversation = real;
  assert.equal((await a('GET', '/api/bottle')).body.bottle.body, 'Rough night. Anyone around?');
});
