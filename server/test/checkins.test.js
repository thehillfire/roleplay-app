const test = require('node:test');
const assert = require('node:assert/strict');
const { start, signedUp, client } = require('./helpers');

const today = () => new Date().toISOString().slice(0, 10);

test('daily check-ins are private, one per day, and validated', async (t) => {
  const s = await start();
  t.after(s.stop);
  const alice = await signedUp(s.base);
  const bob = await signedUp(s.base);
  assert.equal((await client(s.base)('GET', '/api/checkins')).status, 401);
  assert.deepEqual((await alice('GET', '/api/checkins')).body.checkins, []);

  assert.equal((await alice('POST', '/api/checkins', { day: today(), mood: 9 })).status, 400);
  assert.equal((await alice('POST', '/api/checkins', { day: '2001-01-01', mood: 3 })).status, 400, 'no backdating');
  assert.equal((await alice('POST', '/api/checkins', { day: today(), mood: 2 })).status, 200);
  const again = await alice('POST', '/api/checkins', { day: today(), mood: 4 });
  assert.deepEqual(again.body.checkins, [{ day: today(), mood: 4 }], 'same day updates');
  assert.deepEqual((await bob('GET', '/api/checkins')).body.checkins, [], "nobody else's");

  const exported = await (await fetch(`${s.base}/api/account/export`, { headers: { Cookie: alice.cookie() } })).json();
  assert.deepEqual(exported.dailyCheckins, [{ day: today(), mood: 4 }]);
  await alice('POST', '/api/account/delete', { password: 'quiet-harbor-9' });
  assert.equal(Number((await s.db.query('SELECT COUNT(*) AS n FROM checkins')).rows[0].n), 0, 'deleted with the account');
});

test('asking for a reset or confirmation email never touches check-ins', async (t) => {
  const s = await start();
  t.after(s.stop);
  const alice = await signedUp(s.base, { email: 'mood-keeper@example.com' });
  await alice('POST', '/api/checkins', { day: today(), mood: 3 });
  await client(s.base)('POST', '/api/auth/forgot', { email: 'mood-keeper@example.com' });
  await alice('POST', '/api/auth/resend-verification', {});
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual((await alice('GET', '/api/checkins')).body.checkins, [{ day: today(), mood: 3 }]);
});
