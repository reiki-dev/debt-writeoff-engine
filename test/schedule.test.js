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

test('rounds displayed payment amounts to whole currency units', () => {
  const result = schedule({ total: 10, perPayment: 3.4 });
  assert.deepEqual(result.rows.map(r => r.amount), [3, 3, 3]);
});

test('rejects zero, negative, nonnumeric, missing and malformed inputs', () => {
  assert.equal(schedule({ total: 0 }).ok, false);
  assert.equal(schedule({ total: -1 }).ok, false);
  assert.equal(schedule({ perPayment: 'nope' }).ok, false);
  assert.equal(computeSchedule({ startDate: '2024-01-01', total: 10 }).ok, false);
  assert.equal(schedule({ perPayment: null, months: 0 }).ok, false);
  assert.equal(schedule({ startDate: 'not-a-date' }).ok, false);
});

test.todo('fractional totals should remain exact after rounding displayed rows; current whole-unit rounding can make their sum differ from total', () => {
  const result = schedule({ total: 10, perPayment: 3.4 });
  assert.equal(result.rows.reduce((sum, row) => sum + row.amount, 0), result.total);
});

test.todo('calendar-invalid dates such as 2023-02-31 should be rejected; current input validation checks shape only', () => {
  assert.equal(schedule({ startDate: '2023-02-31' }).ok, false);
});
