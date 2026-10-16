const test = require('node:test');
const assert = require('node:assert/strict');
const { start, signedUp } = require('./helpers');

async function matched(s, a, b) {
  const aws = await a.socket();
  const bws = await b.socket();
  aws.send({ type: 'match.join', role: 'talk' });
  await aws.next('match.waiting');
  bws.send({ type: 'match.join', role: 'listen' });
  const { conversationId } = await aws.next('match.found');
  await bws.next('match.found');
  return { id: conversationId, aws, bws, close: () => Promise.all([aws.close().catch(() => {}), bws.close().catch(() => {})]) };
}

const idOf = async (s, api) => (await s.db.query('SELECT id FROM users WHERE handle = $1', [api.user.handle])).rows[0].id;

test('contact info is held: sender sees why, partner never receives it', async (t) => {
  const s = await start();
  t.after(s.stop);
  const alice = await signedUp(s.base);
  const bob = await signedUp(s.base);
  const c = await matched(s, alice, bob);
  t.after(c.close);

  const res = await alice('POST', `/api/conversations/${c.id}/messages`, { body: 'text me 555 123 4567' });
  assert.equal(res.status, 201);
  assert.equal(res.body.message.status, 'held');
  assert.deepEqual(res.body.message.flags, ['contact']);

  await alice('POST', `/api/conversations/${c.id}/messages`, { body: 'ok never mind, how was your day?' });
  const pushed = await c.bws.next('message');
  assert.equal(pushed.message.body, 'ok never mind, how was your day?', 'only the clean message was pushed');

  const bobView = (await bob('GET', `/api/conversations/${c.id}`)).body.messages;
  assert.deepEqual(bobView.map((m) => m.body), ['ok never mind, how was your day?']);
  const aliceView = (await alice('GET', `/api/conversations/${c.id}`)).body.messages;
  assert.equal(aliceView.length, 2);
  assert.deepEqual(aliceView[0].flags, ['contact']);
  assert.equal((await bob('GET', '/api/conversations')).body.conversations[0].lastMessage.body, 'ok never mind, how was your day?');
});

test('crisis messages are delivered, flagged for both sides', async (t) => {
  const s = await start();
  t.after(s.stop);
  const alice = await signedUp(s.base);
  const bob = await signedUp(s.base);
  const c = await matched(s, alice, bob);
  t.after(c.close);
  const res = await alice('POST', `/api/conversations/${c.id}/messages`, { body: 'honestly I just want to die' });
  assert.equal(res.body.crisis, true);
  assert.equal(res.body.message.status, 'delivered');
  const pushed = await c.bws.next('message');
  assert.equal(pushed.message.crisis, true);
});

test('saying you are a minor pauses the account and ends the chat', async (t) => {
  const s = await start();
  t.after(s.stop);
  const alice = await signedUp(s.base);
  const bob = await signedUp(s.base);
  const c = await matched(s, alice, bob);
  t.after(c.close);
  const res = await alice('POST', `/api/conversations/${c.id}/messages`, { body: "lol I'm 15 years old btw" });
  assert.equal(res.body.paused, true);
  assert.equal(res.body.message.status, 'held');
  assert.equal((await c.bws.next('conversation.ended')).conversationId, c.id);
  assert.equal((await alice('GET', '/api/auth/me')).body.user.status, 'review');
  const blocked = await alice('POST', `/api/conversations/${c.id}/messages`, { body: 'hello?' });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.paused, true);
  await assert.rejects(alice.socket(), { status: 403 });
});

test('block ends the conversation for both and hides it', async (t) => {
  const s = await start();
  t.after(s.stop);
  const alice = await signedUp(s.base);
  const bob = await signedUp(s.base);
  const c = await matched(s, alice, bob);
  t.after(c.close);
  assert.equal((await bob('POST', `/api/conversations/${c.id}/block`, {})).status, 200);
  assert.equal((await c.aws.next('conversation.ended')).conversationId, c.id);
  assert.equal((await alice('POST', `/api/conversations/${c.id}/messages`, { body: 'hey' })).status, 403);
  assert.equal((await alice('GET', '/api/conversations')).body.conversations.length, 0);
  assert.equal((await bob('GET', '/api/conversations')).body.conversations.length, 0);
});

test('reports snapshot the chat, block by default, and auto-pause repeat offenders', async (t) => {
  const s = await start({ autoPauseMinReporterAgeMs: 0 });
  t.after(s.stop);
  const troll = await signedUp(s.base);
  const trollId = await idOf(s, troll);
  for (let i = 0; i < 3; i += 1) {
    const victim = await signedUp(s.base);
    const c = await matched(s, troll, victim);
    await troll('POST', `/api/conversations/${c.id}/messages`, { body: `you are pathetic ${i}` });
    assert.equal((await victim('POST', `/api/conversations/${c.id}/report`, { reason: 'nonsense' })).status, 400);
    const res = await victim('POST', `/api/conversations/${c.id}/report`, { reason: 'harassment', details: 'Insults' });
    assert.equal(res.status, 201);
    await c.close();
    const status = (await s.store.getUser(trollId)).status;
    assert.equal(status, i < 2 ? 'active' : 'review', `after ${i + 1} reports`);
  }
  const reports = await s.store.listReports();
  assert.equal(reports.length, 3);
  assert.equal(reports[0].snapshot[0].from, 'reported');
  assert.match(reports[0].snapshot[0].body, /pathetic/);
});

test('moderators review reports and held messages; members cannot', async (t) => {
  const s = await start();
  t.after(s.stop);
  const alice = await signedUp(s.base);
  const bob = await signedUp(s.base);
  const mod = await signedUp(s.base, { email: 'mod@example.com' });
  await s.store.setUserRole('mod@example.com', 'admin');
  const c = await matched(s, alice, bob);
  t.after(c.close);
  await alice('POST', `/api/conversations/${c.id}/messages`, { body: 'send nudes' });
  await bob('POST', `/api/conversations/${c.id}/report`, { reason: 'sexual' });

  assert.equal((await alice('GET', '/api/admin/reports')).status, 403);

  const held = (await mod('GET', '/api/admin/held')).body.messages;
  assert.equal(held[0].body, 'send nudes');
  assert.deepEqual(held[0].flags, ['sexual']);

  const [report] = (await mod('GET', '/api/admin/reports')).body.reports;
  assert.equal(report.reason, 'sexual');
  assert.equal(report.reported.handle, alice.user.handle);
  assert.equal((await mod('POST', `/api/admin/reports/${report.id}/resolve`, { resolution: 'suspended' })).status, 200);
  assert.equal((await mod('POST', `/api/admin/reports/${report.id}/resolve`, { resolution: 'suspended' })).status, 404, 'already resolved');
  assert.equal((await alice('GET', '/api/auth/me')).body.user.status, 'suspended');
  assert.equal((await mod('GET', '/api/admin/reports')).body.reports.length, 0);

  const aliceId = await idOf(s, alice);
  await mod('POST', `/api/admin/users/${aliceId}/status`, { status: 'active' });
  assert.equal((await alice('GET', '/api/auth/me')).body.user.status, 'active');
});

test('ADMIN_EMAILS only makes a verified owner of that email a moderator', async (t) => {
  const sent = [];
  const mailer = { enabled: true, send: async (m) => { sent.push(m); } };
  const s = await start({ adminEmails: ['boss@example.com'], mailer });
  t.after(s.stop);

  // Registering the owner's address doesn't grant anything until the inbox is proven.
  const squatter = await signedUp(s.base, { email: 'Boss@Example.com' });
  assert.equal(squatter.user.role, 'member');
  assert.equal(squatter.user.emailVerified, false);
  assert.equal((await squatter('GET', '/api/admin/reports')).status, 403);
  await squatter('POST', '/api/auth/logout', {});
  assert.equal((await squatter('POST', '/api/auth/login', { email: 'boss@example.com', password: 'quiet-harbor-9' })).body.user.role, 'member');

  // Following the emailed link proves it; the next sign-in is a moderator.
  await new Promise((r) => setTimeout(r, 20));
  const token = sent.find((m) => m.to === 'boss@example.com').text.match(/\/verify#([\w-]+)/)[1];
  assert.equal((await squatter('POST', '/api/auth/verify', { token })).status, 200);
  assert.equal((await squatter('POST', '/api/auth/verify', { token })).status, 400, 'single use');
  const me = (await squatter('GET', '/api/auth/me')).body.user;
  assert.equal(me.role, 'admin');
  assert.equal(me.emailVerified, true);
  assert.equal((await squatter('GET', '/api/admin/reports')).status, 200);

  const member = await signedUp(s.base);
  assert.equal(member.user.role, 'member');
});

test('moderators cannot restore or suspend an account its owner deleted', async (t) => {
  const s = await start();
  t.after(s.stop);
  const mod = await signedUp(s.base, { email: 'mod2@example.com' });
  await s.store.setUserRole('mod2@example.com', 'admin');
  const gone = await signedUp(s.base);
  const goneId = (await s.db.query('SELECT id FROM users WHERE handle = $1', [gone.user.handle])).rows[0].id;
  await gone('POST', '/api/account/delete', { password: 'quiet-harbor-9' });
  assert.equal((await mod('POST', `/api/admin/users/${goneId}/status`, { status: 'active' })).status, 409);
  assert.equal((await s.store.getUser(goneId)).status, 'deleted');
});

test('fresh throwaway accounts cannot brigade someone into a pause', async (t) => {
  const s = await start(); // default: reporters must be at least a day old to count
  t.after(s.stop);
  const target = await signedUp(s.base);
  const targetId = (await s.db.query('SELECT id FROM users WHERE handle = $1', [target.user.handle])).rows[0].id;
  for (let i = 0; i < 3; i += 1) {
    const sock = await signedUp(s.base);
    const c = await matched(s, target, sock);
    await sock('POST', `/api/conversations/${c.id}/report`, { reason: 'harassment' });
    await c.close();
  }
  assert.equal((await s.store.getUser(targetId)).status, 'active');
  assert.equal((await s.store.listReports()).length, 3, 'reports still reach moderators');
});

test('there is a daily cap on meeting new people', async (t) => {
  const s = await start({ realtime: { dailyMatchLimit: 1 } });
  t.after(s.stop);
  const alice = await signedUp(s.base);
  const c = await matched(s, alice, await signedUp(s.base));
  t.after(c.close);
  c.aws.send({ type: 'match.join', role: 'talk' });
  const err = await c.aws.next('match.error');
  assert.match(err.error, /met a lot of new people today/);
  assert.equal(s.server.realtime.matchmaker.size, 0);
});

test('moderators see headline stats', async (t) => {
  const s = await start({ autoPauseMinReporterAgeMs: 0 });
  t.after(s.stop);
  const mod = await signedUp(s.base, { email: 'stats-mod@example.com' });
  await s.store.setUserRole('stats-mod@example.com', 'admin');
  const a = await signedUp(s.base);
  const b = await signedUp(s.base);
  const c = await matched(s, a, b);
  t.after(c.close);
  await a('POST', `/api/conversations/${c.id}/messages`, { body: 'hi' });
  await b('POST', `/api/conversations/${c.id}/messages`, { body: 'hey' });
  await a('POST', `/api/conversations/${c.id}/messages`, { body: 'send nudes' });
  await b('POST', `/api/conversations/${c.id}/report`, { reason: 'sexual' });
  assert.equal((await a('GET', '/api/admin/stats')).status, 403);
  const stats = (await mod('GET', '/api/admin/stats')).body;
  assert.equal(stats.users, 3);
  assert.equal(stats.signupsDay, 3);
  assert.equal(stats.activeDay, 2);
  assert.equal(stats.messagesDay, 2);
  assert.equal(stats.matchesDay, 1);
  assert.equal(stats.revenueCents, 0);
  assert.equal(typeof stats.online, 'number');
});

test('"under 18" reports count even from brand-new accounts (child safety over brigading)', async (t) => {
  const s = await start(); // default reporter-age rule applies to other reasons only
  t.after(s.stop);
  const suspect = await signedUp(s.base);
  const suspectId = (await s.db.query('SELECT id FROM users WHERE handle = $1', [suspect.user.handle])).rows[0].id;
  for (let i = 0; i < 2; i += 1) {
    const reporter = await signedUp(s.base);
    const c = await matched(s, suspect, reporter);
    await reporter('POST', `/api/conversations/${c.id}/report`, { reason: 'minor' });
    await c.close();
  }
  assert.equal((await s.store.getUser(suspectId)).status, 'review');
});

test('two tabs joining at once only queue once', async (t) => {
  const s = await start();
  t.after(s.stop);
  const alice = await signedUp(s.base);
  const tab1 = await alice.socket();
  const tab2 = await alice.socket();
  t.after(() => Promise.all([tab1.close(), tab2.close()]));
  tab1.send({ type: 'match.join', role: 'talk' });
  tab2.send({ type: 'match.join', role: 'talk' });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(s.server.realtime.matchmaker.size, 1, 'one queue entry for the person, not one per tab');
  const bob = await signedUp(s.base);
  const bws = await bob.socket();
  t.after(() => bws.close());
  bws.send({ type: 'match.join', role: 'listen' });
  await bws.next('match.found');
  await new Promise((r) => setTimeout(r, 150));
  const found = [...tab1.events, ...tab2.events].filter((e) => e.type === 'match.found');
  assert.equal(new Set(found.map((e) => e.conversationId)).size, 1, 'matched exactly once');
  assert.equal(s.server.realtime.matchmaker.size, 0);
});

test('the same long message pasted to many people is held as spam', async (t) => {
  const s = await start({ realtime: { dailyMatchLimit: 100 } });
  t.after(s.stop);
  const spammer = await signedUp(s.base);
  const promo = 'Check out my amazing crypto group, guaranteed returns every week!!';
  const results = [];
  for (let i = 0; i < 3; i += 1) {
    const c = await matched(s, spammer, await signedUp(s.base));
    results.push((await spammer('POST', `/api/conversations/${c.id}/messages`, { body: promo })).body.message.status);
    await spammer('POST', `/api/conversations/${c.id}/messages`, { body: 'hi there' }); // short greetings are fine
    await c.close();
  }
  assert.deepEqual(results, ['delivered', 'delivered', 'held']);
  const held = await s.store.listHeldMessages();
  assert.deepEqual(held[0].flags, ['spam']);
});
