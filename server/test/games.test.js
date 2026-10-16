const test = require('node:test');
const assert = require('node:assert/strict');
const { start, signedUp } = require('./helpers');

async function playing(s, mode) {
  const a = await signedUp(s.base);
  const b = await signedUp(s.base);
  const aws = await a.socket();
  const bws = await b.socket();
  aws.send({ type: 'match.join', mode });
  await aws.next('match.waiting');
  bws.send({ type: 'match.join', mode });
  const found = await aws.next('match.found');
  await bws.next('match.found');
  return { a, b, aws, bws, id: found.conversationId, found, close: () => Promise.all([aws.close(), bws.close()]) };
}

test('a Cringe Duel match records its mode, relays card moves, and skips "did this help?"', async (t) => {
  const s = await start();
  t.after(s.stop);
  const g = await playing(s, 'cringe');
  t.after(g.close);
  assert.equal(g.found.mode, 'cringe');
  const convo = (await g.a('GET', `/api/conversations/${g.id}`)).body.conversation;
  assert.equal(convo.mode, 'cringe');
  assert.equal((await g.a('GET', '/api/conversations')).body.conversations[0].mode, 'cringe');

  g.aws.send({ type: 'game', conversationId: g.id, kind: 'card', card: 7 });
  const { seen, ...card } = await g.bws.next('game');
  assert.deepEqual(card, { type: 'game', conversationId: g.id, kind: 'card', card: 7 });

  for (let i = 0; i < 2; i++) {
    await g.a('POST', `/api/conversations/${g.id}/messages`, { body: `ok ${i}` });
    await g.b('POST', `/api/conversations/${g.id}/messages`, { body: `yes ${i}` });
  }
  assert.equal((await g.a('GET', `/api/conversations/${g.id}`)).body.conversation.feedback.canRate, false);
});

test("Don't Smile relays smiles; junk and other people's chats are ignored", async (t) => {
  const s = await start();
  t.after(s.stop);
  const g = await playing(s, 'nosmile');
  t.after(g.close);
  const outsider = await signedUp(s.base);
  const ows = await outsider.socket();
  t.after(() => ows.close());

  ows.send({ type: 'game', conversationId: g.id, kind: 'smiled' }); // not their chat
  g.aws.send({ type: 'game', conversationId: g.id, kind: 'explode' }); // not a game move
  g.aws.send({ type: 'game', conversationId: g.id, kind: 'smiled', card: -3 });
  const { seen, ...smile } = await g.bws.next('game');
  assert.deepEqual(smile, { type: 'game', conversationId: g.id, kind: 'smiled' }, 'the bad card number is dropped');
});

test('matching again in another mode switches the chat to it', async (t) => {
  const s = await start();
  t.after(s.stop);
  const g = await playing(s, 'nosmile');
  await g.close();
  const a = await g.a.socket();
  const b = await g.b.socket();
  t.after(() => Promise.all([a.close(), b.close()]));
  a.send({ type: 'match.join', role: 'talk' });
  await a.next('match.waiting');
  b.send({ type: 'match.join', role: 'listen' });
  assert.equal((await a.next('match.found')).conversationId, g.id, 'same pair, same thread');
  assert.equal((await g.a('GET', `/api/conversations/${g.id}`)).body.conversation.mode, 'talk');
});
