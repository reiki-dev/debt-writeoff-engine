'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { toMinor, toMinorOrZero, fromMinor, sumMinor, MoneyError } = require('../src/money');

test('parses export strings', () => {
  assert.equal(toMinor('12345.67'), 1234567);
  assert.equal(toMinor('0.00'), 0);
  assert.equal(toMinor('1725'), 172500);
  assert.equal(toMinor('1725.5'), 172550);
  assert.equal(toMinor('1 725,00'), 172500);      // space separator and decimal comma
  assert.equal(toMinor(25000), 2500000);
});

test('refuses to guess', () => {
  assert.throws(() => toMinor(''), MoneyError);
  assert.throws(() => toMinor(null), MoneyError);
  assert.throws(() => toMinor('0000-00-00'), MoneyError);
  assert.throws(() => toMinor('abc'), MoneyError);
  // A third decimal place is unsupported precision and must not be rounded silently.
  assert.throws(() => toMinor('10.005'), MoneyError);
  // Trailing zeroes in the third decimal place are allowed.
  assert.equal(toMinor('10.500'), 1050);
});

test('toMinorOrZero distinguishes "missing column" from zero', () => {
  assert.equal(toMinorOrZero(undefined), 0);
  assert.equal(toMinorOrZero(''), 0);
  assert.equal(toMinorOrZero('0.00'), 0);
  assert.throws(() => toMinorOrZero('missing'), MoneyError);
});

test('round-trip preserves minor units', () => {
  for (const value of ['0.00', '0.01', '12345.67', '765.43', '18000.00', '99999999.99']) {
    assert.equal(fromMinor(toMinor(value)), value);
  }
});

test('sums use integers without float drift', () => {
  // 0.1 + 0.2 in floating point yields 0.30000000000000004.
  const parts = ['0.10', '0.20'].map((v) => toMinor(v));
  assert.equal(fromMinor(sumMinor(parts)), '0.30');

  // A realistic set of buckets.
  const buckets = ['100.00', '100.00', '100.00', '100.00', '300.00', '400.00', '250.00', '75.50'];
  assert.equal(fromMinor(sumMinor(buckets.map((v) => toMinor(v)))), '1425.50');
});
