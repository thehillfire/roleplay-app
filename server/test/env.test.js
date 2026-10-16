const test = require('node:test');
const assert = require('node:assert/strict');
const { envInt } = require('../src/env');

test('envInt accepts 0, falls back on junk', () => {
  process.env.KINDRED_TEST_INT = '0';
  assert.equal(envInt('KINDRED_TEST_INT', 40), 0);
  process.env.KINDRED_TEST_INT = '12';
  assert.equal(envInt('KINDRED_TEST_INT', 40), 12);
  const warn = console.warn;
  console.warn = () => {};
  process.env.KINDRED_TEST_INT = 'lots';
  assert.equal(envInt('KINDRED_TEST_INT', 40), 40);
  console.warn = warn;
  delete process.env.KINDRED_TEST_INT;
  assert.equal(envInt('KINDRED_TEST_INT', 40), 40);
});
