'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeSchedule } = require('../pipeline/src/schedule');

const schedule = (overrides = {}) => computeSchedule({ startDate: '2024-01-31', total: 100, perPayment: 30, ...overrides });

test('clamps month ends, including leap and common February', () => {
  assert.deepEqual(schedule({ startDate: '2023-01-31', total: 60, months: 2 }).rows.map(r => r.date), ['2023-01-31', '2023-02-28']);
  assert.deepEqual(schedule({ startDate: '2024-01-31', total: 60, months: 2 }).rows.map(r => r.date), ['2024-01-31', '2024-02-29']);
});

test('steps across a year boundary', () => {
  assert.deepEqual(schedule({ startDate: '2024-12-31', total: 30, perPayment: 20, months: 2 }).rows.map(r => r.date), ['2024-12-31', '2025-01-31']);
});

test('perPayment at least total produces one payment', () => {
  const result = schedule({ total: 25, perPayment: 25 });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].amount, 25);
});

test('last payment receives the remaining amount and integer schedule totals match', () => {
  const result = schedule({ total: 100, perPayment: 33 });
  assert.equal(result.rows.at(-1).amount, 1);
  assert.equal(result.rows.reduce((sum, row) => sum + row.amount, 0), 100);
});

test('preserves fractional currency amounts to minor-unit precision', () => {
  const result = schedule({ total: 10, perPayment: 3.4 });
  assert.deepEqual(result.rows.map(r => r.amount), [3.4, 3.4, 3.2]);
  assert.equal(result.rows.reduce((sum, row) => sum + row.amount, 0), result.total);
});

test('rejects zero, negative, nonnumeric, missing and malformed inputs', () => {
  assert.equal(schedule({ total: 0 }).ok, false);
  assert.equal(schedule({ total: -1 }).ok, false);
  assert.equal(schedule({ perPayment: 'nope' }).ok, false);
  assert.equal(computeSchedule({ startDate: '2024-01-01', total: 10 }).ok, false);
  assert.equal(schedule({ perPayment: null, months: 0 }).ok, false);
  assert.equal(schedule({ startDate: 'not-a-date' }).ok, false);
});

test('fractional totals remain exact when split across payments', () => {
  const result = schedule({ total: 1000.10, perPayment: 333.33 });
  assert.deepEqual(result.rows.map(r => r.amount), [333.33, 333.33, 333.33, 0.11]);
  assert.equal(result.rows.reduce((sum, row) => sum + row.amount, 0), result.total);
});

test('calendar-invalid dates are rejected with a guard code', () => {
  assert.equal(schedule({ startDate: '2023-02-31' }).ok, false);
  assert.equal(schedule({ startDate: '2024-13-01' }).guards[0].code, 'start_date_invalid');
});

test('total smaller than perPayment produces one exact payment', () => {
  const result = schedule({ total: 12.34, perPayment: 100 });
  assert.deepEqual(result.rows.map(r => r.amount), [12.34]);
});

test('exactly divisible minor-unit total has equal payments', () => {
  const result = schedule({ total: 99.99, perPayment: 33.33 });
  assert.deepEqual(result.rows.map(r => r.amount), [33.33, 33.33, 33.33]);
});

test('leap-day start remains on the last valid day in later February years', () => {
  const result = computeSchedule({ startDate: '2024-02-29', total: 60, months: 13 });
  assert.equal(result.rows[0].date, '2024-02-29');
  assert.equal(result.rows[12].date, '2025-02-28');
});

test('rejects currency precision beyond minor units with a clear guard', () => {
  const result = schedule({ total: 10.001 });
  assert.equal(result.ok, false);
  assert.equal(result.guards[0].code, 'amount_precision_invalid');
});
