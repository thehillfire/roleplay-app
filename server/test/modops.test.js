const test = require('node:test');
const assert = require('node:assert/strict');
const { start, client, adult, signedUp } = require('./helpers');

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

test('support: members write in, moderators reply by email without seeing the address', async (t) => {
  const sent = [];
  const s = await start({ mailer: { enabled: true, send: async (m) => { sent.push(m); } }, publicUrl: 'https://kindred.example' });
  t.after(s.stop);
  const mod = await moderator(s, 'mod-support@example.com');
  const member = await signedUp(s.base, { email: 'writer@example.com' });
  const memberId = (await s.db.query('SELECT id FROM users WHERE email = $1', ['writer@example.com'])).rows[0].id;
  await s.store.markEmailVerified(memberId);

  assert.equal((await member('POST', '/api/support', { topic: 'feedback', message: '' })).status, 400);
  assert.equal((await member('POST', '/api/support', { topic: 'feedback', message: 'x' })).status, 400, 'too short to act on');
  assert.equal((await member('POST', '/api/support', { topic: 'feedback', message: 'I was charged twice this month.' })).status, 201);
  await new Promise((r) => setTimeout(r, 20));
  const alert = sent.find((m) => m.to === 'mod-support@example.com' && m.subject === '[Kindred] New support request');
  assert.ok(alert, 'moderators are told');
  assert.ok(!alert.text.includes('charged twice'), 'but not what it says');

  const { requests } = (await mod('GET', '/api/admin/support')).body;
  assert.equal(requests.length, 1);
  assert.equal(requests[0].user.handle, member.user.handle);
  assert.ok(!JSON.stringify(requests).includes('writer@example.com'), 'no email for moderators');
  assert.equal((await member('GET', '/api/admin/support')).status, 403);

  const reply = 'Sorry about that. We refunded the duplicate charge.';
  assert.equal((await mod('POST', `/api/admin/support/${requests[0].id}/resolve`, { reply })).status, 200);
  assert.equal((await mod('POST', `/api/admin/support/${requests[0].id}/resolve`, { reply })).status, 404, 'answered once');
  await new Promise((r) => setTimeout(r, 20));
  const email = sent.find((m) => m.to === 'writer@example.com' && m.subject.startsWith('Kindred support'));
  assert.match(email.text, /refunded the duplicate charge/);

  const mine = (await member('GET', '/api/support')).body.requests;
  assert.deepEqual([mine[0].status, mine[0].reply], ['resolved', reply]);
  assert.equal((await mod('GET', '/api/admin/log')).body.actions[0].action, 'support_replied');

  // Unconfirmed address: the reply is kept in the app but never emailed (may be a typo or someone else's inbox).
  const unverified = await signedUp(s.base, { email: 'not-mine@example.com' });
  await unverified('POST', '/api/support', { topic: 'safety', message: 'Someone was rude to me.' });
  const [open] = (await mod('GET', '/api/admin/support')).body.requests;
  assert.equal((await mod('POST', `/api/admin/support/${open.id}/resolve`, { reply: 'Thanks, we looked into it.' })).body.emailed, false);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(!sent.some((m) => m.to === 'not-mine@example.com' && m.subject.startsWith('Kindred support')));
  assert.equal((await unverified('GET', '/api/support')).body.requests[0].reply, 'Thanks, we looked into it.');

  // At most three open at once per person.
  for (let i = 0; i < 3; i += 1) assert.equal((await member('POST', '/api/support', { topic: 'other', message: `question ${i}` })).status, 201);
  assert.equal((await member('POST', '/api/support', { topic: 'other', message: 'one more' })).status, 429);
});

test('ban evasion: a new account on a suspended account\'s device waits for review', async (t) => {
  const sent = [];
  const s = await start({ mailer: { enabled: true, send: async (m) => { sent.push(m); } } });
  t.after(s.stop);
  const mod = await moderator(s, 'mod-evasion@example.com');
  const troll = await signedUp(s.base);
  const device = troll.device();
  assert.ok(device, 'a device cookie is set at signup');
  const trollId = (await s.db.query('SELECT id FROM users WHERE handle = $1', [troll.user.handle])).rows[0].id;
  await mod('POST', `/api/admin/users/${trollId}/status`, { status: 'suspended' });

  // Same browser, new email: paused for review, logged, moderators told.
  const again = await signedUp(s.base, undefined, { device });
  assert.equal(again.user.status, 'review');
  assert.equal((await again('GET', '/api/conversations')).status, 403);
  assert.equal((await mod('GET', '/api/admin/log')).body.actions[0].detail, 'Signed up on the device of a suspended account');
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(sent.some((m) => m.subject === '[Kindred] Possible ban evasion paused'));

  // Another browser is unaffected.
  assert.equal((await signedUp(s.base)).user.status, 'active');

  // Deleting the suspended account doesn't lift the ban; a moderator restoring it does.
  await mod('POST', `/api/admin/users/${trollId}/status`, { status: 'active' });
  assert.equal((await signedUp(s.base, undefined, { device })).user.status, 'active');
});

test('held messages: a moderator can deliver a false positive or keep it held, once', async (t) => {
  const s = await start();
  t.after(s.stop);
  const mod = await moderator(s, 'mod-held@example.com');
  const a = await signedUp(s.base);
  const b = await signedUp(s.base);
  const c = await matched(a, b);
  t.after(c.close);
  const bws = await b.socket();
  t.after(() => bws.close());
  await a('POST', `/api/conversations/${c.id}/messages`, { body: 'can we hang out here a bit longer, in this chat I mean' });
  await a('POST', `/api/conversations/${c.id}/messages`, { body: 'whats your snap?' });
  let held = (await mod('GET', '/api/admin/held')).body.messages;
  assert.equal(held.length, 2);
  const falsePositive = held.find((m) => m.body.startsWith('can we'));
  const real = held.find((m) => m.body === 'whats your snap?');

  assert.equal((await mod('POST', `/api/admin/held/${falsePositive.id}/review`, { release: 'yes' })).status, 400);
  assert.equal((await mod('POST', `/api/admin/held/${falsePositive.id}/review`, { release: true })).status, 200);
  const pushed = await bws.next('message');
  assert.equal(pushed.message.body, 'can we hang out here a bit longer, in this chat I mean');
  assert.ok(!('senderId' in pushed.message) && !('flags' in pushed.message));
  assert.equal((await mod('POST', `/api/admin/held/${falsePositive.id}/review`, { release: true })).status, 404, 'once');
  assert.equal((await mod('POST', `/api/admin/held/${real.id}/review`, { release: false })).status, 200);

  held = (await mod('GET', '/api/admin/held')).body.messages;
  assert.deepEqual(held, [], 'both left the queue');
  const bodies = (await b('GET', `/api/conversations/${c.id}`)).body.messages.map((m) => m.body);
  assert.ok(bodies.includes('can we hang out here a bit longer, in this chat I mean'));
  assert.ok(!bodies.includes('whats your snap?'), 'kept held stays hidden');
  const actions = (await mod('GET', '/api/admin/log')).body.actions.map((x) => x.action);
  assert.deepEqual(actions.slice(0, 2), ['held_kept', 'held_released']);
  assert.equal((await b('POST', `/api/admin/held/${real.id}/review`, { release: true })).status, 403);
});

test('reviewing a report tells the reporter it was read, and a warning reaches the person', async (t) => {
  const s = await start();
  t.after(s.stop);
  const mod = await moderator(s, 'mod-notice@example.com');
  const a = await signedUp(s.base);
  const b = await signedUp(s.base);
  const c = await matched(a, b);
  t.after(c.close);
  await a('POST', `/api/conversations/${c.id}/messages`, { body: 'you are pathetic' });
  await b('POST', `/api/conversations/${c.id}/report`, { reason: 'harassment', block: false });
  const [report] = (await mod('GET', '/api/admin/reports')).body.reports;
  await mod('POST', `/api/admin/reports/${report.id}/resolve`, { resolution: 'warned' });

  const reporterNotice = (await b('GET', '/api/auth/me')).body.user.notice;
  assert.match(reporterNotice, /A moderator has reviewed it/);
  assert.ok(!/warn|suspend|dismiss/i.test(reporterNotice), 'never the outcome');
  assert.match((await a('GET', '/api/auth/me')).body.user.notice, /keep to the guidelines/);

  assert.equal((await b('POST', '/api/account/notice/dismiss', {})).status, 200);
  assert.equal((await b('GET', '/api/auth/me')).body.user.notice, null, 'shown once');
});

test('an under-18 refusal followed by an older birthdate on the same browser waits for review', async (t) => {
  const s = await start();
  t.after(s.stop);
  const browser = client(s.base);
  const kid = await browser('POST', '/api/auth/signup', adult({ birthdate: `${new Date().getUTCFullYear() - 15}-03-03` }));
  assert.equal(kid.status, 403);
  const retry = await browser('POST', '/api/auth/signup', adult({ birthdate: '1990-03-03' }));
  assert.equal(retry.status, 201);
  assert.equal(retry.body.user.status, 'review');
  const mod = await moderator(s, 'mod-underage@example.com');
  assert.equal((await mod('GET', '/api/admin/log')).body.actions.find((a) => a.action === 'auto_pause').detail, 'Signed up on a device that was refused as under 18');
  // A different browser is unaffected.
  assert.equal((await signedUp(s.base)).user.status, 'active');
});

test('a moderator restoring an account clears an under-18 refusal flag on its browser', async (t) => {
  const s = await start();
  t.after(s.stop);
  const mod = await moderator(s, 'mod-typo@example.com');
  const browser = client(s.base);
  await browser('POST', '/api/auth/signup', adult({ birthdate: `${new Date().getUTCFullYear() - 15}-03-03` })); // a typo
  const adultAccount = await browser('POST', '/api/auth/signup', adult({ birthdate: '1990-03-03' }));
  assert.equal(adultAccount.body.user.status, 'review');
  await mod('POST', `/api/admin/users/${adultAccount.body.user.id}/status`, { status: 'active' });
  await browser('POST', '/api/auth/logout', {});
  const next = await browser('POST', '/api/auth/signup', adult({ birthdate: '1985-05-05' }));
  assert.equal(next.body.user.status, 'active', 'the next adult on that browser is not paused');
});

test('a denied appeal shows its outcome and note, and a new note can follow a week later', async (t) => {
  const s = await start();
  t.after(s.stop);
  const mod = await moderator(s, 'mod-appeal-note@example.com');
  const person = await signedUp(s.base);
  const personId = (await s.db.query('SELECT id FROM users WHERE handle = $1', [person.user.handle])).rows[0].id;
  await s.store.setUserStatus(personId, 'review');
  await person('POST', '/api/appeal', { message: 'This is the only place I can talk.' });
  assert.equal((await person('GET', '/api/appeal')).body.appeal.status, 'open');
  const [appeal] = (await mod('GET', '/api/admin/appeals')).body.appeals;
  await mod('POST', `/api/admin/appeals/${appeal.id}/resolve`, { restore: false, note: 'Several people reported threats. We will look again next week.' });

  const seen = (await person('GET', '/api/appeal')).body.appeal;
  assert.equal(seen.decision, 'denied');
  assert.equal(seen.note, 'Several people reported threats. We will look again next week.');
  assert.ok(seen.nextAppealAt > Date.now());
  assert.equal((await person('POST', '/api/appeal', { message: 'please' })).status, 429, 'one note a week after a no');
  await s.db.query('UPDATE appeals SET resolved_at = $1', [Date.now() - 8 * 24 * 60 * 60 * 1000]);
  assert.equal((await person('POST', '/api/appeal', { message: 'I have thought about it.' })).status, 201);
});

test('after a restore, a later pause starts with a fresh appeal', async (t) => {
  const s = await start();
  t.after(s.stop);
  const mod = await moderator(s, 'mod-appeal-fresh@example.com');
  const person = await signedUp(s.base);
  const personId = (await s.db.query('SELECT id FROM users WHERE handle = $1', [person.user.handle])).rows[0].id;
  await mod('POST', `/api/admin/users/${personId}/status`, { status: 'suspended' });
  await person('POST', '/api/appeal', { message: 'first time' });
  const [appeal] = (await mod('GET', '/api/admin/appeals')).body.appeals;
  assert.deepEqual(appeal.pausedBy, { action: 'suspend', detail: null });
  await mod('POST', `/api/admin/appeals/${appeal.id}/resolve`, { restore: false, note: 'not yet' });
  await s.store.setUserStatus(personId, 'active'); // restored later from Look up
  await s.store.setUserStatus(personId, 'suspended'); // and paused again for something new
  assert.equal((await person('GET', '/api/appeal')).body.appeal, null, 'the old decision belonged to the old pause');
  assert.equal((await person('POST', '/api/appeal', { message: 'this time is different' })).status, 201);
  const [second] = (await mod('GET', '/api/admin/appeals')).body.appeals;
  assert.equal(second.pausedBy.action, 'suspend', 'the cause, not the earlier "keep paused"');
});

test('a wrong password is not mistaken for a lost session', async (t) => {
  const s = await start();
  t.after(s.stop);
  const person = await signedUp(s.base);
  const wrong = await person('POST', '/api/account/delete', { password: 'not-my-password' });
  assert.equal(wrong.status, 401);
  assert.notEqual(wrong.body.code, 'signed_out');
  await person('POST', '/api/auth/logout', {});
  const gone = await person('GET', '/api/conversations');
  assert.equal(gone.status, 401);
  assert.equal(gone.body.code, 'signed_out');
});

test('held messages come with the few messages just before them', async (t) => {
  const s = await start();
  t.after(s.stop);
  const mod = await moderator(s, 'mod-context@example.com');
  const a = await signedUp(s.base);
  const b = await signedUp(s.base);
  const c = await matched(a, b);
  t.after(c.close);
  await b('POST', `/api/conversations/${c.id}/messages`, { body: 'how was your week' });
  await a('POST', `/api/conversations/${c.id}/messages`, { body: 'rough, my kid had a fever' });
  await a('POST', `/api/conversations/${c.id}/messages`, { body: 'whats your snap?' });
  const [held] = (await mod('GET', '/api/admin/held')).body.messages;
  assert.equal(held.body, 'whats your snap?');
  assert.deepEqual(held.context, [
    { fromSender: false, body: 'how was your week', unsent: false },
    { fromSender: true, body: 'rough, my kid had a fever', unsent: false },
  ]);
});
