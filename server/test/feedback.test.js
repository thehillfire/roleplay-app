const test = require('node:test');
const assert = require('node:assert/strict');
const { start, signedUp } = require('./helpers');

test('after a real exchange, "this helped" thanks the listener once and counts distinct people', async (t) => {
  const s = await start();
  t.after(s.stop);
  const listener = await signedUp(s.base);
  const lws = await listener.socket();
  t.after(() => lws.close());

  for (let i = 0; i < 2; i += 1) {
    const talker = await signedUp(s.base);
    const tws = await talker.socket();
    tws.send({ type: 'match.join', role: 'talk' });
    await tws.next('match.waiting');
    lws.send({ type: 'match.join', role: 'listen' });
    const { conversationId: id } = await tws.next('match.found');
    await lws.next('match.found');

    const url = `/api/conversations/${id}/feedback`;
    let convo = (await talker('GET', `/api/conversations/${id}`)).body.conversation;
    assert.deepEqual(convo.feedback, { canRate: false, helpful: null });
    assert.equal((await talker('POST', url, { helpful: true })).status, 409, 'too early');

    for (const [who, body] of [[talker, 'rough week'], [listener, 'tell me about it'], [talker, 'boss again'], [listener, 'that sounds exhausting']]) {
      await who('POST', `/api/conversations/${id}/messages`, { body });
    }
    convo = (await talker('GET', `/api/conversations/${id}`)).body.conversation;
    assert.equal(convo.feedback.canRate, true);

    assert.equal((await talker('POST', url, { helpful: 'yes' })).status, 400);
    assert.equal((await talker('POST', url, { helpful: true })).status, 200);
    const thanks = await lws.next('thanks');
    assert.ok(!('from' in thanks), 'anonymous thank-you');
    await talker('POST', url, { helpful: true }); // repeat vote: no second thank-you
    assert.equal((await talker('GET', `/api/conversations/${id}`)).body.conversation.feedback.helpful, true);
    await tws.close();
  }
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(lws.events.filter((e) => e.type === 'thanks').length, 2, 'one thank-you per person');
  assert.equal((await listener('GET', '/api/auth/me')).body.user.helped, 2);
});

test('kind words: a screened note with a thank-you, kept for the listener, who can remove it', async (t) => {
  const s = await start();
  t.after(s.stop);
  const talker = await signedUp(s.base);
  const listener = await signedUp(s.base);
  const tws = await talker.socket();
  const lws = await listener.socket();
  t.after(() => Promise.all([tws.close(), lws.close()]));
  tws.send({ type: 'match.join', role: 'talk' });
  await tws.next('match.waiting');
  lws.send({ type: 'match.join', role: 'listen' });
  const { conversationId: id } = await tws.next('match.found');
  for (const [who, body] of [[talker, 'rough week'], [listener, 'I hear you'], [talker, 'thanks for listening'], [listener, 'any time']]) {
    await who('POST', `/api/conversations/${id}/messages`, { body });
  }
  const say = (note) => talker('POST', `/api/conversations/${id}/kind-words`, { note });

  assert.equal((await say('You were so patient with me')).status, 409, 'needs a "helped" vote first');
  await talker('POST', `/api/conversations/${id}/feedback`, { helpful: true });
  assert.equal((await say('text me 555-123-4567')).status, 400, 'no contact details');
  assert.equal((await say('x'.repeat(141))).status, 400);
  assert.equal((await say('You were so patient with me. Thank you.')).status, 201);
  await lws.next('kind_words');

  const { kindWords } = (await listener('GET', '/api/kind-words')).body;
  assert.equal(kindWords.length, 1);
  assert.equal(kindWords[0].note, 'You were so patient with me. Thank you.');
  assert.ok(!JSON.stringify(kindWords).includes(talker.user.handle), 'never says who');
  assert.deepEqual((await talker('GET', '/api/kind-words')).body.kindWords, [], 'only for the listener');
  assert.equal((await listener('GET', '/api/account/export')).body.kindWordsYouReceived.length, 1);

  assert.ok(!('conversationId' in kindWords[0]), 'nothing ties the note to a conversation');
  const noteId = kindWords[0].id;
  assert.equal((await talker('POST', `/api/kind-words/${noteId}/hide`, {})).status, 404, 'only the recipient can remove it');
  assert.equal((await listener('POST', `/api/kind-words/${noteId}/hide`, {})).status, 200);
  assert.deepEqual((await listener('GET', '/api/kind-words')).body.kindWords, []);
  assert.equal((await say('Please read this again')).status, 409, 'a removed note stays removed');
  assert.deepEqual((await listener('GET', '/api/kind-words')).body.kindWords, []);
});

test('kind words and thanks stop at a block, and thanks are anonymous and sent once', async (t) => {
  const s = await start();
  t.after(s.stop);
  const talker = await signedUp(s.base);
  const listener = await signedUp(s.base);
  const tws = await talker.socket();
  const lws = await listener.socket();
  t.after(() => Promise.all([tws.close(), lws.close()]));
  tws.send({ type: 'match.join', role: 'talk' });
  await tws.next('match.waiting');
  lws.send({ type: 'match.join', role: 'listen' });
  const { conversationId: id } = await tws.next('match.found');
  for (const [who, body] of [[talker, 'rough week'], [listener, 'I hear you'], [talker, 'thanks for listening'], [listener, 'any time']]) {
    await who('POST', `/api/conversations/${id}/messages`, { body });
  }
  await talker('POST', `/api/conversations/${id}/feedback`, { helpful: true });
  const thanks = await lws.next('thanks');
  assert.deepEqual(Object.keys(thanks).filter((k) => k !== 'seen'), ['type'], 'no name with the thank-you');
  await talker('POST', `/api/conversations/${id}/kind-words`, { note: 'You helped a lot.' });
  await talker('POST', `/api/conversations/${id}/feedback`, { helpful: false });
  await talker('POST', `/api/conversations/${id}/feedback`, { helpful: true });

  await listener('POST', `/api/conversations/${id}/block`, {});
  assert.equal((await talker('POST', `/api/conversations/${id}/kind-words`, { note: 'Why did you block me' })).status, 403);
  assert.equal((await talker('POST', `/api/conversations/${id}/feedback`, { helpful: true })).status, 403);
  assert.deepEqual((await listener('GET', '/api/kind-words')).body.kindWords, [], 'notes from a blocked person disappear');
  assert.equal(lws.events.filter((e) => e.type === 'thanks').length, 1, 'flipping the vote never re-sends thanks');
});
