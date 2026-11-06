'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { allocate } = require('../src/waterfall');
const { ORDER } = require('../src/buckets');
const { toMinor, fromMinor } = require('../src/money');

function buckets(spec) {
  const out = {};
  for (const bucket of ORDER) out[bucket] = 0;
  for (const [bucket, value] of Object.entries(spec)) out[bucket] = toMinor(value);
  return out;
}

test('hierarchy is respected: tax12 first, principal last', () => {
  const result = allocate({
    buckets: buckets({ tax12: '100.00', tax1: '100.00', amount: '100.00' }),
    order: ORDER,
    amount: toMinor('150.00'),
  });

  assert.equal(fromMinor(result.allocation.tax12), '100.00');
  assert.equal(fromMinor(result.allocation.tax1), '50.00');
  assert.equal(result.allocation.amount, undefined);   // Principal is untouched.
  assert.equal(result.shortfall, 0);
});

test('the last affected bucket is reduced partially', () => {
  const result = allocate({
    buckets: buckets({ tax8: '2000.00', late_fee: '2208.00', amount: '10000.00' }),
    order: ORDER,
    amount: toMinor('3000.00'),
  });

  assert.equal(fromMinor(result.allocation.tax8), '2000.00');
  assert.equal(fromMinor(result.allocation.late_fee), '1000.00');
  assert.equal(result.allocation.amount, undefined);

  const lateFeeStep = result.steps.find((s) => s.bucket === 'late_fee');
  assert.equal(lateFeeStep.partial, true);
});

test('order is tax12..tax1, not lexicographic', () => {
  // Lexicographic sorting would put tax10 before tax9; verify it does not.
  const result = allocate({
    buckets: buckets({ tax9: '10.00', tax10: '10.00' }),
    order: ORDER,
    amount: toMinor('10.00'),
  });
  assert.equal(fromMinor(result.allocation.tax10), '10.00');
  assert.equal(result.allocation.tax9, undefined);
});

test('order is tax12..tax6, then tax2..tax5, then tax1', () => {
  const result = allocate({
    buckets: buckets({
      tax6: '10.00', tax2: '10.00', tax3: '10.00', tax4: '10.00', tax5: '10.00', tax1: '10.00',
      charge: '10.00', cinterest: '10.00', late_fee: '10.00', amount: '10.00',
    }),
    order: ORDER,
    amount: toMinor('35.00'),
  });
  assert.equal(fromMinor(result.allocation.tax6), '10.00');
  assert.equal(fromMinor(result.allocation.tax2), '10.00');
  assert.equal(fromMinor(result.allocation.tax3), '10.00');
  assert.equal(fromMinor(result.allocation.tax4), '5.00');
  assert.equal(result.allocation.tax5, undefined);
  assert.equal(result.allocation.tax1, undefined);
  assert.equal(result.allocation.charge, undefined);
  assert.equal(result.allocation.cinterest, undefined);
  assert.equal(result.allocation.late_fee, undefined);
  assert.equal(result.allocation.amount, undefined);
});

test('charge is cleared before cinterest and late_fee', () => {
  const result = allocate({
    buckets: buckets({
      charge: '100.00', cinterest: '100.00', late_fee: '100.00',
    }),
    order: ORDER,
    amount: toMinor('150.00'),
  });
  assert.equal(fromMinor(result.allocation.charge), '100.00');
  assert.equal(fromMinor(result.allocation.cinterest), '50.00');
  assert.equal(result.allocation.late_fee, undefined);
});

test('never takes more than a bucket balance', () => {
  const spec = buckets({ tax5: '50.00', amount: '30.00' });
  const result = allocate({ buckets: spec, order: ORDER, amount: toMinor('1000.00') });

  for (const [bucket, taken] of Object.entries(result.allocation)) {
    assert.ok(taken <= spec[bucket], `${bucket}: amount exceeds balance`);
  }
  assert.equal(fromMinor(result.allocated), '80.00');
  assert.equal(fromMinor(result.shortfall), '920.00');
});

test('zero amount allocates nothing', () => {
  const result = allocate({ buckets: buckets({ amount: '100.00' }), order: ORDER, amount: 0 });
  assert.deepEqual(result.allocation, {});
  assert.equal(result.allocated, 0);
});

test('rejects floats and negative values', () => {
  assert.throws(() => allocate({ buckets: buckets({}), order: ORDER, amount: 10.5 }), TypeError);
  assert.throws(() => allocate({ buckets: buckets({}), order: ORDER, amount: -100 }), RangeError);
  assert.throws(
    () => allocate({ buckets: { ...buckets({}), amount: -5 }, order: ORDER, amount: 100 }),
    RangeError,
  );
});
