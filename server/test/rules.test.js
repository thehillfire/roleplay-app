const test = require('node:test');
const assert = require('node:assert/strict');
const { initialState, applyEffects, normalizeState, rollD20, MAX_ITEMS } = require('../src/rules');
const { boot } = require('../src/boot');

test('rollD20 covers 1 through 20', () => {
  assert.equal(rollD20(() => 0), 1);
  assert.equal(rollD20(() => 0.9999), 20);
});

test('applyEffects clamps HP swings and bounds', () => {
  const s = initialState();
  assert.equal(applyEffects(s, { hpChange: -999 }).state.hp, 75, 'a single hit is capped at 25');
  assert.equal(applyEffects(s, { hpChange: 50 }).state.hp, 100, 'cannot heal above max');
  assert.deepEqual(applyEffects(s, { hpChange: 10 }).applied, {}, 'no-op heal at full HP reports nothing');
  const low = { ...s, hp: 10 };
  const { state, applied } = applyEffects(low, { hpChange: -20 });
  assert.equal(state.hp, 0);
  assert.equal(state.ended, true);
  assert.deepEqual(applied, { hp: -10, ended: true });
});

test('applyEffects only removes carried items and dedupes gains', () => {
  const s = { ...initialState(), inventory: ['Lantern', 'Rope'] };
  const { state, applied } = applyEffects(s, { loseItems: ['rope', 'Crown'], gainItems: ['lantern', ' Silver   Key ', ''] });
  assert.deepEqual(state.inventory, ['Lantern', 'Silver Key']);
  assert.deepEqual(applied, { gained: ['Silver Key'], lost: ['Rope'] });
});

test('applyEffects caps inventory size and sets quests', () => {
  const s = { ...initialState(), inventory: Array.from({ length: MAX_ITEMS }, (_, i) => `Item ${i}`) };
  const { state, applied } = applyEffects(s, { gainItems: ['One too many'], quest: 'Find the bell' });
  assert.equal(state.inventory.length, MAX_ITEMS);
  assert.deepEqual(applied, { quest: 'Find the bell' });
});

test('normalizeState repairs untrusted input', () => {
  const s = normalizeState({ hp: 5000, maxHp: 9999, inventory: ['a', 'A', 42, 'x'.repeat(100)], quest: 7 });
  assert.equal(s.hp, 100);
  assert.equal(s.maxHp, 100);
  assert.deepEqual(s.inventory, ['a', 'x'.repeat(40)]);
  assert.equal(s.quest, '');
  assert.deepEqual(normalizeState(null), initialState());
});

async function start(narrator, rng) {
  const { app, db } = await boot({ db: { url: '', sqliteFile: ':memory:' }, narrator, rng });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  return { base: `http://127.0.0.1:${server.address().port}`, stop: () => new Promise((r) => server.close(r)).then(() => db.close()) };
}

const hero = { name: 'Ash Diver' };
const post = (base, body) => fetch(`${base}/api/story`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

test('the roll is only shown when the narrator used it', async (t) => {
  let used = true;
  const narrator = { source: 't', describeClass: async () => ({}), tell: async ({ roll }) => ({ passage: `rolled ${roll}`, choices: [], rollUsed: used, effects: {} }) };
  const s = await start(narrator, () => 0.5);
  t.after(s.stop);
  const history = [{ role: 'narrator', text: 'Start' }];
  const a = await post(s.base, { hero, history, action: 'Leap' });
  assert.equal(a.body.turns[1].roll, 11);
  assert.equal(a.body.turns[1].text, 'rolled 11');
  used = false;
  const b = await post(s.base, { hero, history, action: 'Sit' });
  assert.equal(b.body.turns[1].roll, undefined);
});

test('reaching 0 HP ends the tale and blocks further turns', async (t) => {
  const narrator = { source: 't', describeClass: async () => ({}), tell: async () => ({ passage: 'Ouch.', choices: ['More'], rollUsed: true, effects: { hpChange: -25 } }) };
  const s = await start(narrator, () => 0);
  t.after(s.stop);
  const history = [{ role: 'narrator', text: 'Start' }];
  const res = await post(s.base, { hero, history, state: { hp: 20, inventory: [] }, action: 'Charge' });
  assert.equal(res.body.state.hp, 0);
  assert.equal(res.body.state.ended, true);
  assert.deepEqual(res.body.choices, []);
  assert.deepEqual(res.body.turns[1].effects, { hp: -20, ended: true });
  const again = await post(s.base, { hero, history, state: res.body.state, action: 'Get up' });
  assert.equal(again.status, 409);
});

test('guest state cannot be inflated by the client', async (t) => {
  const narrator = { source: 't', describeClass: async () => ({}), tell: async ({ state }) => ({ passage: `HP ${state.hp}`, choices: [], rollUsed: false, effects: {} }) };
  const s = await start(narrator);
  t.after(s.stop);
  const res = await post(s.base, { hero, history: [{ role: 'narrator', text: 'x' }], state: { hp: 1e9, maxHp: 1e9 }, action: 'Look' });
  assert.equal(res.body.turns[1].text, 'HP 100');
});
