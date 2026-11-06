'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mockCrm = require('../mock-crm');
const { ORDER, SOURCE_COLUMN } = require('../writeoff/src/buckets');
const { toMinor } = require('../writeoff/src/money');

test('mock loan 2001 buckets reconcile to debt in exact minor units', () => {
  const row = mockCrm.getMockCreditRows({ customerId: '1001', creditId: '2001' })[0];
  const bucketTotal = ORDER.reduce((sum, bucket) => sum + toMinor(row[SOURCE_COLUMN[bucket]] || '0'), 0);
  assert.equal(bucketTotal, toMinor(row.debt));
  assert.equal(ORDER.length, 16);
});
