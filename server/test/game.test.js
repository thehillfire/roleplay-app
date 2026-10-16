const test = require('node:test');
const assert = require('node:assert/strict');
const { rollRarity, rollClassSeed, RARITY_NAMES } = require('../src/game');

test('rollRarity maps the bottom of the range to Common and the top to Eternal', () => {
  assert.equal(rollRarity(() => 0), 'Common');
  assert.equal(rollRarity(() => 0.999999), 'Eternal');
});

test('rollRarity follows the weight table', () => {
  // Common is 45 of 100 total weight, so 0.44 is Common and 0.46 is Uncommon.
  assert.equal(rollRarity(() => 0.44), 'Common');
  assert.equal(rollRarity(() => 0.46), 'Uncommon');
});

test('rollClassSeed returns a known rarity, theme and role', () => {
  const seed = rollClassSeed();
  assert.ok(RARITY_NAMES.includes(seed.rarity));
  assert.equal(typeof seed.theme, 'string');
  assert.equal(typeof seed.role, 'string');
});
