const test = require('node:test');
const assert = require('node:assert/strict');
const { createMatchmaker } = require('../src/matchmaker');

function setup(opts = {}) {
  let t = 0;
  const matches = [];
  const mm = createMatchmaker({ onMatch: (a, b) => matches.push([a.userId, b.userId].sort()), now: () => t, sameRoleAfterMs: 30000, ...opts });
  return { mm, matches, advance: (ms) => { t += ms; } };
}

test('a talker and a listener match immediately', () => {
  const { mm, matches } = setup();
  assert.equal(mm.join({ userId: 'a', role: 'talk' }), false);
  assert.equal(mm.join({ userId: 'b', role: 'listen' }), true);
  assert.deepEqual(matches, [['a', 'b']]);
  assert.equal(mm.size, 0);
});

test('"either" matches anyone', () => {
  const { mm, matches } = setup();
  mm.join({ userId: 'a', role: 'talk' });
  mm.join({ userId: 'b', role: 'either' });
  assert.deepEqual(matches, [['a', 'b']]);
});

test('two talkers wait, then pair up after the grace period', () => {
  const { mm, matches, advance } = setup();
  mm.join({ userId: 'a', role: 'talk' });
  mm.join({ userId: 'b', role: 'talk' });
  mm.sweep();
  assert.deepEqual(matches, []);
  advance(30001);
  mm.sweep();
  assert.deepEqual(matches, [['a', 'b']]);
});

test('blocked pairs never match, in either direction', () => {
  const { mm, matches, advance } = setup();
  mm.join({ userId: 'a', role: 'talk', blocked: new Set(['b']) });
  mm.join({ userId: 'b', role: 'listen' });
  advance(60000);
  mm.sweep();
  assert.deepEqual(matches, []);
  mm.join({ userId: 'c', role: 'listen' });
  assert.deepEqual(matches, [['a', 'c']]);
});

test('new people are preferred over past partners, and shared topics over none', () => {
  const { mm, matches } = setup();
  mm.join({ userId: 'old', role: 'listen' });
  mm.join({ userId: 'fresh', role: 'listen' });
  mm.join({ userId: 'topical', role: 'listen', topic: 'money' });
  mm.join({ userId: 'me', role: 'talk', topic: 'money', known: new Set(['old']) });
  assert.deepEqual(matches, [['me', 'topical']]);
});

test('leaving the queue and rejoining replaces the old entry', () => {
  const { mm, matches } = setup();
  mm.join({ userId: 'a', role: 'talk' });
  mm.join({ userId: 'a', role: 'talk' });
  assert.equal(mm.size, 1);
  assert.equal(mm.leave('a'), true);
  mm.join({ userId: 'b', role: 'listen' });
  assert.deepEqual(matches, []);
  assert.equal(mm.isQueued('b'), true);
});

test('nobody matches themselves', () => {
  const { mm, matches, advance } = setup();
  mm.join({ userId: 'a', role: 'either' });
  advance(60000);
  mm.sweep();
  assert.deepEqual(matches, []);
});

test('people near the same age are preferred, but never required', () => {
  const { mm, matches } = setup();
  mm.join({ userId: 'older', role: 'listen', ageBand: '50+' });
  mm.join({ userId: 'peer', role: 'listen', ageBand: '18-24' });
  mm.join({ userId: 'student', role: 'talk', ageBand: '18-24' });
  assert.deepEqual(matches, [['peer', 'student']]);
  mm.join({ userId: 'another', role: 'talk', ageBand: '25-34' });
  assert.deepEqual(matches[1], ['another', 'older'], 'different bands still match');
});

test('topic outweighs age band', () => {
  const { mm, matches } = setup();
  mm.join({ userId: 'sameAge', role: 'listen', ageBand: '25-34' });
  mm.join({ userId: 'sameTopic', role: 'listen', topic: 'money', ageBand: '50+' });
  mm.join({ userId: 'me', role: 'talk', topic: 'money', ageBand: '25-34' });
  assert.deepEqual(matches, [['me', 'sameTopic']]);
});

test('counts who is waiting in each role', () => {
  const { mm } = setup();
  mm.join({ userId: 'a', role: 'talk' });
  mm.join({ userId: 'b', role: 'talk' });
  assert.deepEqual(mm.waitingByRole(), { talk: 2, listen: 0, either: 0 });
});

test('game modes only match people in the same mode, and ignore talk/listen', () => {
  const { mm, matches } = setup();
  assert.equal(mm.join({ userId: 'a', mode: 'cringe' }), false);
  assert.equal(mm.join({ userId: 'b', mode: 'talk', role: 'either' }), false, 'support mode never meets a game');
  assert.equal(mm.join({ userId: 'c', mode: 'nosmile' }), false);
  assert.equal(mm.join({ userId: 'd', mode: 'cringe', role: 'talk' }), true, 'roles do not matter in a game');
  assert.deepEqual(matches, [['a', 'd']]);
  assert.deepEqual(mm.waitingByMode(), { talk: 1, cringe: 0, nosmile: 1 });
  assert.deepEqual(mm.waitingByRole(), { talk: 0, listen: 0, either: 1 }, 'listener counts are support mode only');
});

test('an unknown mode falls back to the support mode', () => {
  const { mm, matches } = setup();
  mm.join({ userId: 'a', mode: 'bogus', role: 'talk' });
  mm.join({ userId: 'b', role: 'listen' });
  assert.deepEqual(matches, [['a', 'b']]);
});
