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
