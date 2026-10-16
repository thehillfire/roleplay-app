const test = require('node:test');
const assert = require('node:assert/strict');
const { start, signedUp } = require('./helpers');

async function matched(a, b) {
  const aws = await a.socket();
  const bws = await b.socket();
  aws.send({ type: 'match.join', role: 'talk' });
  await aws.next('match.waiting');
  bws.send({ type: 'match.join', role: 'listen' });
  const { conversationId: id } = await aws.next('match.found');
  await bws.next('match.found');
  return { id, close: () => Promise.all([aws.close().catch(() => {}), bws.close().catch(() => {})]) };
}

async function moderator(s, email) {
  const mod = await signedUp(s.base, { email });
  await s.store.setUserRole(email, 'admin');
  const id = (await s.db.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id;
  await s.store.markEmailVerified(id);
  return mod;
}

test('urgent reports email verified moderators, without message text', async (t) => {
  const sent = [];
  const s = await start({ mailer: { enabled: true, send: async (m) => { sent.push(m); } }, publicUrl: 'https://kindred.example' });
  t.after(s.stop);
  await moderator(s, 'mod-alerts@example.com');
  const a = await signedUp(s.base);
  const b = await signedUp(s.base);
  const c = await matched(a, b);
  t.after(c.close);
  await a('POST', `/api/conversations/${c.id}/messages`, { body: 'my secret is safe here' });
  await b('POST', `/api/conversations/${c.id}/report`, { reason: 'self_harm', block: false });
  await b('POST', `/api/conversations/${c.id}/report`, { reason: 'spam', block: false });
  await new Promise((r) => setTimeout(r, 30));
  const alerts = sent.filter((m) => m.to === 'mod-alerts@example.com' && m.subject.startsWith('[Kindred]'));
  assert.equal(alerts.length, 1, 'only the urgent one');
  assert.match(alerts[0].subject, /may be at risk/);
  assert.ok(!alerts[0].text.includes('secret'));
  assert.match(alerts[0].text, /https:\/\/kindred\.example\//);
});

test('moderator actions are logged, including automatic ones', async (t) => {
  const s = await start({ autoPauseMinReporterAgeMs: 0 });
  t.after(s.stop);
  const mod = await moderator(s, 'mod-log@example.com');
  const kid = await signedUp(s.base);
  const other = await signedUp(s.base);
  const c = await matched(kid, other);
  t.after(c.close);
  await kid('POST', `/api/conversations/${c.id}/messages`, { body: "I'm 14 years old" });
  const kidId = (await s.db.query('SELECT id FROM users WHERE handle = $1', [kid.user.handle])).rows[0].id;
  await mod('POST', `/api/admin/users/${kidId}/status`, { status: 'suspended' });
  const { actions } = (await mod('GET', '/api/admin/log')).body;
  assert.deepEqual(actions.map((a) => [a.action, a.moderator, a.target]), [
    ['suspend', mod.user.handle, kid.user.handle],
    ['auto_pause', 'system', kid.user.handle],
  ]);
  assert.equal((await kid('GET', '/api/admin/log')).status, 403);
});

test('paused people can appeal; moderators grant or deny', async (t) => {
  const s = await start();
  t.after(s.stop);
  const mod = await moderator(s, 'mod-appeals@example.com');
  const person = await signedUp(s.base);
  const personId = (await s.db.query('SELECT id FROM users WHERE handle = $1', [person.user.handle])).rows[0].id;

  assert.equal((await person('POST', '/api/appeal', { message: 'hi' })).status, 409, 'active accounts have nothing to appeal');
  await s.store.setUserStatus(personId, 'review');
  assert.equal((await person('POST', '/api/appeal', { message: '' })).status, 400);
  const filed = await person('POST', '/api/appeal', { message: "I'm 34, I was talking about my kid's age." });
  assert.equal(filed.status, 201);
  assert.match((await person('GET', '/api/appeal')).body.appeal.message, /34/);

  const [appeal] = (await mod('GET', '/api/admin/appeals')).body.appeals;
  assert.equal(appeal.user.handle, person.user.handle);
  assert.equal((await mod('POST', `/api/admin/appeals/${appeal.id}/resolve`, { restore: true })).status, 200);
  assert.equal((await person('GET', '/api/auth/me')).body.user.status, 'active');
  assert.deepEqual((await mod('GET', '/api/admin/appeals')).body.appeals, []);
  assert.equal((await mod('GET', '/api/admin/log')).body.actions[0].action, 'appeal_granted');
});

test('appeals are decided once, and a deleted account is logged honestly', async (t) => {
  const s = await start();
  t.after(s.stop);
  const mod = await moderator(s, 'mod-appeal2@example.com');
  const person = await signedUp(s.base);
  const personId = (await s.db.query('SELECT id FROM users WHERE handle = $1', [person.user.handle])).rows[0].id;
  await s.store.setUserStatus(personId, 'review');
  await person('POST', '/api/appeal', { message: 'please look again' });
  const [appeal] = (await mod('GET', '/api/admin/appeals')).body.appeals;
  await person('POST', '/api/account/delete', { password: 'quiet-harbor-9' });
  const first = await mod('POST', `/api/admin/appeals/${appeal.id}/resolve`, { restore: true });
  assert.equal(first.body.action, 'appeal_closed_account_deleted');
  assert.equal((await mod('POST', `/api/admin/appeals/${appeal.id}/resolve`, { restore: false })).status, 404, 'no second decision');
});

test('the audit log survives purging the accounts it mentions', async (t) => {
  const s = await start();
  t.after(s.stop);
  const mod = await moderator(s, 'mod-purge@example.com');
  const target = await signedUp(s.base);
  const targetId = (await s.db.query('SELECT id FROM users WHERE handle = $1', [target.user.handle])).rows[0].id;
  await mod('POST', `/api/admin/users/${targetId}/status`, { status: 'suspended' });
  await target('POST', '/api/account/delete', { password: 'quiet-harbor-9' }).catch(() => {});
  await s.store.deleteAccount(targetId);
  await s.store.purgeDeleted(Date.now() + 1000);
  const [entry] = (await mod('GET', '/api/admin/log')).body.actions;
  assert.equal(entry.action, 'suspend');
  assert.equal(entry.target, target.user.handle, 'still says who it was about');
  assert.equal(entry.moderator, mod.user.handle);
});

test('moderators can look someone up by handle, without seeing their email', async (t) => {
  const s = await start();
  t.after(s.stop);
  const mod = await moderator(s, 'mod-lookup@example.com');
  const a = await signedUp(s.base, { email: 'private-person@example.com' });
  const b = await signedUp(s.base);
  const c = await matched(a, b);
  t.after(c.close);
  await a('POST', `/api/conversations/${c.id}/messages`, { body: 'text me at 555-123-4567' });
  await b('POST', `/api/conversations/${c.id}/report`, { reason: 'harassment', block: false });

  const res = await mod('GET', `/api/admin/users?handle=${encodeURIComponent(`@${a.user.handle.toLowerCase()}`)}`);
  assert.equal(res.status, 200);
  const { user } = res.body;
  assert.equal(user.handle, a.user.handle, 'case-insensitive, leading @ ignored');
  assert.equal(user.status, 'active');
  assert.deepEqual([user.reportsOpen, user.reportsTotal, user.reportsMade, user.held], [1, 1, 0, 1]);
  assert.ok(!JSON.stringify(res.body).includes('private-person'), 'no email');

  await mod('POST', `/api/admin/users/${user.id}/status`, { status: 'suspended' });
  const after = (await mod('GET', `/api/admin/users?handle=${a.user.handle}`)).body.user;
  assert.equal(after.status, 'suspended');
  assert.equal(after.actions[0].action, 'suspend');

  assert.equal((await mod('GET', '/api/admin/users?handle=NoSuchPerson99')).status, 404);
  assert.equal((await mod('GET', '/api/admin/users')).status, 400);
  assert.equal((await b('GET', `/api/admin/users?handle=${a.user.handle}`)).status, 403);
});
