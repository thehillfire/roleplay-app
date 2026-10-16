const test = require('node:test');
const assert = require('node:assert/strict');
const { start, signedUp, adult, client } = require('./helpers');

async function chatting(s) {
  const alice = await signedUp(s.base, { email: `alice${Date.now()}@example.com` });
  const bob = await signedUp(s.base);
  const aws = await alice.socket();
  const bws = await bob.socket();
  aws.send({ type: 'match.join', role: 'talk' });
  await aws.next('match.waiting');
  bws.send({ type: 'match.join', role: 'listen' });
  const { conversationId: id } = await aws.next('match.found');
  await alice('POST', `/api/conversations/${id}/messages`, { body: 'hello from alice' });
  await bob('POST', `/api/conversations/${id}/messages`, { body: 'hi alice' });
  await alice('POST', `/api/conversations/${id}/messages`, { body: 'call me 555 123 4567' }); // held
  return { alice, bob, aws, bws, id, close: () => Promise.all([aws.close(), bws.close()]) };
}

test('export contains your account and the conversations you can see', async (t) => {
  const s = await start();
  t.after(s.stop);
  const c = await chatting(s);
  t.after(c.close);
  const res = await fetch(`${s.base}/api/account/export`, { headers: { Cookie: c.alice.cookie() } });
  assert.match(res.headers.get('content-disposition'), /attachment; filename="kindred-/);
  const data = await res.json();
  assert.equal(data.account.handle, c.alice.user.handle);
  assert.equal(data.account.birthdate, '1995-04-12');
  assert.equal(data.conversations[0].with, c.bob.user.handle);
  assert.deepEqual(data.conversations[0].messages.map((m) => [m.from, m.body, m.delivered]), [
    ['you', 'hello from alice', true],
    [c.bob.user.handle, 'hi alice', true],
    ['you', 'call me 555 123 4567', false],
  ]);
  const bobData = await (await fetch(`${s.base}/api/account/export`, { headers: { Cookie: c.bob.cookie() } })).json();
  assert.equal(bobData.conversations[0].messages.length, 2, "Bob's export excludes Alice's held message");
});

test('deleting an account needs the password, scrubs personal data, and frees the email', async (t) => {
  const s = await start();
  t.after(s.stop);
  const c = await chatting(s);
  t.after(c.close);
  const email = (await s.db.query('SELECT email FROM users WHERE handle = $1', [c.alice.user.handle])).rows[0].email;

  assert.equal((await c.alice('POST', '/api/account/delete', { password: 'wrong' })).status, 401);
  assert.equal((await c.alice('POST', '/api/account/delete', { password: 'quiet-harbor-9' })).status, 200);
  assert.equal((await c.bws.next('conversation.ended')).conversationId, c.id);

  assert.equal((await c.alice('GET', '/api/auth/me')).body.user, null, 'signed out');
  assert.equal((await client(s.base)('POST', '/api/auth/login', { email, password: 'quiet-harbor-9' })).status, 401);
  const row = (await s.db.query('SELECT email, birthdate, status FROM users WHERE handle = $1', [c.alice.user.handle])).rows[0];
  assert.equal(row.status, 'deleted');
  assert.ok(!row.email.includes('alice'));
  assert.equal(row.birthdate, '0000-00-00');

  const reply = await c.bob('POST', `/api/conversations/${c.id}/messages`, { body: 'are you still there?' });
  assert.equal(reply.status, 403);
  assert.equal(reply.body.error, 'This person has left Kindred.');

  // The email can be used again for a brand-new account.
  assert.equal((await client(s.base)('POST', '/api/auth/signup', adult({ email }))).status, 201);
});

test('deleted accounts keep safety data until the retention period, then are purged', async (t) => {
  const s = await start();
  t.after(s.stop);
  const c = await chatting(s);
  t.after(c.close);
  await c.bob('POST', `/api/conversations/${c.id}/report`, { reason: 'harassment' });
  await c.alice('POST', '/api/account/delete', { password: 'quiet-harbor-9' });

  assert.equal((await s.store.listReports()).length, 1, 'report survives deletion');
  assert.equal(await s.store.purgeDeleted(Date.now() - 60 * 1000), 0, 'not old enough yet');
  assert.equal(await s.store.purgeDeleted(Date.now() + 1000), 1);
  assert.equal((await s.store.listReports()).length, 0);
  assert.equal(Number((await s.db.query('SELECT COUNT(*) AS n FROM messages')).rows[0].n), 0);
});

test('old messages are purged; report snapshots keep their copy', async (t) => {
  const s = await start({ autoPauseMinReporterAgeMs: 0 });
  t.after(s.stop);
  const c = await chatting(s);
  t.after(c.close);
  await c.bob('POST', `/api/conversations/${c.id}/report`, { reason: 'harassment', block: false });
  await s.db.query('UPDATE messages SET created_at = $1', [Date.now() - 400 * 24 * 60 * 60 * 1000]);
  assert.equal(await s.store.purgeOldMessages(Date.now() - 365 * 24 * 60 * 60 * 1000), 3);
  assert.deepEqual((await c.alice('GET', `/api/conversations/${c.id}`)).body.messages, []);
  const [report] = await s.store.listReports();
  assert.ok(report.snapshot.length > 0, 'the report still shows what was said');
});

test('resolved reports lose their transcript copy after the retention period', async (t) => {
  const s = await start({ autoPauseMinReporterAgeMs: 0 });
  t.after(s.stop);
  const c = await chatting(s);
  t.after(c.close);
  await c.bob('POST', `/api/conversations/${c.id}/report`, { reason: 'harassment', details: 'mean', block: false });
  const [report] = await s.store.listReports();
  await s.store.resolveReport(report.id, 'dismissed');
  assert.equal(await s.store.scrubResolvedReports(Date.now() - 60000), 0, 'too recent');
  assert.equal(await s.store.scrubResolvedReports(Date.now() + 1000), 1);
  const after = await s.store.getReport(report.id);
  assert.deepEqual(after.snapshot, []);
  assert.equal(after.details, null);
});

test('payment records outlive a purged account (accounting and disputes)', async (t) => {
  const s = await start();
  t.after(s.stop);
  const { signedUp } = require('./helpers');
  const a = await signedUp(s.base);
  const id = (await s.db.query('SELECT id FROM users WHERE handle = $1', [a.user.handle])).rows[0].id;
  await s.store.recordPayment({ id: 'cs_keep', userId: id, amountCents: 999, credits: 1 });
  await a('POST', '/api/account/delete', { password: 'quiet-harbor-9' });
  assert.equal(await s.store.purgeDeleted(Date.now() + 1000), 1);
  const { rows } = await s.db.query('SELECT amount_cents FROM payments WHERE id = $1', ['cs_keep']);
  assert.equal(Number(rows[0].amount_cents), 999);
});
