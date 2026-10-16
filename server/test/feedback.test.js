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
    assert.equal(thanks.from, talker.user.handle);
    await talker('POST', url, { helpful: true }); // repeat vote: no second thank-you
    assert.equal((await talker('GET', `/api/conversations/${id}`)).body.conversation.feedback.helpful, true);
    await tws.close();
  }
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(lws.events.filter((e) => e.type === 'thanks').length, 2, 'one thank-you per person');
  assert.equal((await listener('GET', '/api/auth/me')).body.user.helped, 2);
});
