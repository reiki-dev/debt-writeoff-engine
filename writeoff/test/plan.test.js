'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalize } = require('../src/exportReader');
const { buildBalance, selectCreditRow, listDebtors } = require('../src/balance');
const { computePlan, buildPayload, idempotencyKey } = require('../src/plan');
const { ORDER, PAYLOAD_FIELD, API_UNSUPPORTED } = require('../src/buckets');
const { toMinor, fromMinor } = require('../src/money');
const { assocEnvelope } = require('./fixtures');

function balanceOf(overrides) {
  const rows = normalize(assocEnvelope([overrides]).data);
  return buildBalance(rows[0]);
}

function codes(plan) {
  return plan.findings.map((f) => f.code);
}

test('balance collects buckets and reconciles with debt', () => {
  const balance = balanceOf({
    l_tax8: '2000.00', l_tax6: '1500.00', l_late_fee: '2208.00', l_amount: '10000.00',
  });

  assert.equal(fromMinor(balance.buckets.tax8), '2000.00');
  assert.equal(fromMinor(balance.buckets.late_fee), '2208.00');
  assert.equal(fromMinor(balance.bucketSum), '15708.00');
  assert.equal(balance.bucketSum, balance.debt);
  assert.equal(balance.creditId, '2001');
  assert.equal(balance.customerId, '1001');
});

test('plan allocates (debt - target) from top to bottom', () => {
  const balance = balanceOf({
    l_tax8: '2000.00', l_late_fee: '2208.00', l_cinterest: '705.33', l_amount: '20000.00',
  });
  // debt = 24913.33; target is 20000.00 -> write off 4913.33
  const plan = computePlan({ balance, target: toMinor('20000.00') });

  assert.equal(fromMinor(plan.amount), '4913.33');
  assert.equal(fromMinor(plan.allocation.tax8), '2000.00');
  assert.equal(fromMinor(plan.allocation.cinterest), '705.33');
  assert.equal(fromMinor(plan.allocation.late_fee), '2208.00');
  assert.equal(plan.allocation.amount, undefined);
  assert.equal(fromMinor(plan.debtAfterExpected), '20000.00');
  assert.equal(plan.ok, true);
  assert.deepEqual(codes(plan), []);
});

test('partially reduces principal when the allocation reaches it', () => {
  const balance = balanceOf({ l_tax2: '500.00', l_amount: '30000.00' });
  const plan = computePlan({ balance, target: toMinor('25000.00') });

  assert.equal(fromMinor(plan.amount), '5500.00');
  assert.equal(fromMinor(plan.allocation.tax2), '500.00');
  assert.equal(fromMinor(plan.allocation.amount), '5000.00');
  assert.equal(fromMinor(plan.debtAfterExpected), '25000.00');
  assert.equal(plan.ok, true);
});

test('a bucket sum mismatch with debt blocks the plan', () => {
  // 480.00 is in l_administrative_fee, which is outside the waterfall.
  const balance = balanceOf({
    l_amount: '10000.00', l_administrative_fee: '480.00', debt: '10480.00',
  });
  const plan = computePlan({ balance, target: toMinor('5000.00') });

  assert.ok(codes(plan).includes('debt_mismatch'));
  assert.equal(plan.ok, false);
  assert.equal(plan.fatal, true);
  const finding = plan.findings.find((f) => f.code === 'debt_mismatch');
  assert.match(finding.message, /l_administrative_fee=480\.00/);
});

test('tax11/tax12 are applied when fields are enabled in the installation', () => {
  const balance = balanceOf({ l_tax12: '654.00', l_tax11: '400.00', l_amount: '10000.00' });
  const plan = computePlan({ balance, target: toMinor('10000.00') });

  assert.equal(fromMinor(plan.allocation.tax12), '654.00');
  assert.equal(fromMinor(plan.allocation.tax11), '400.00');
  assert.ok(!codes(plan).includes('api_unsupported_bucket'));
  assert.equal(plan.ok, true);

  const payload = buildPayload({ customerId: 1, creditId: 2, allocation: plan.allocation });
  assert.equal(payload.tax12, '654.00');
  assert.equal(payload.tax11, '400.00');
});

test('every bucket in the hierarchy has a field in the writeoff contract', () => {
  // Invariant: ORDER and PAYLOAD_FIELD stay aligned. If they diverge,
  // api_unsupported_bucket activates; let this test catch it before a live write-off.
  assert.deepEqual(API_UNSUPPORTED, []);
  for (const bucket of ORDER) {
    assert.ok(PAYLOAD_FIELD[bucket], `bucket ${bucket} has no field in PAYLOAD_FIELD`);
  }
});

test('a bucket outside the hierarchy cannot be silently omitted from the request', () => {
  assert.throws(
    () => buildPayload({ customerId: 1, creditId: 2, allocation: { tax13: 100 } }),
    /outside the hierarchy: tax13/,
  );
});

test('an unreachable target is caught before sending', () => {
  const balance = balanceOf({ l_amount: '1000.00' });
  const plan = computePlan({ balance, target: 0 });
  assert.equal(plan.shortfall, 0);
  assert.equal(plan.ok, true);

  // Bucket balances are below the debt, so they do not represent it fully.
  // Both capacity and debt reconciliation guards catch this case.
  const broken = balanceOf({ l_amount: '1000.00', debt: '5000.00' });
  const brokenPlan = computePlan({ balance: broken, target: 0 });
  assert.ok(codes(brokenPlan).includes('insufficient_capacity'));
  assert.ok(codes(brokenPlan).includes('debt_mismatch'));
  assert.equal(brokenPlan.ok, false);
});

test('nothing to write off when debt is at or below target', () => {
  const balance = balanceOf({ l_amount: '20000.00' });
  const plan = computePlan({ balance, target: toMinor('25000.00') });

  assert.equal(plan.amount, 0);
  assert.ok(codes(plan).includes('nothing_to_write_off'));
  assert.equal(plan.ok, false);
});

test('court costs can be written off, but produce a warning', () => {
  const balance = balanceOf({ l_tax10: '1500.00', l_tax9: '2000.00', l_amount: '5000.00' });
  const plan = computePlan({ balance, target: toMinor('5000.00') });

  assert.equal(fromMinor(plan.allocation.tax10), '1500.00');
  assert.equal(fromMinor(plan.allocation.tax9), '2000.00');
  const warn = plan.findings.find((f) => f.code === 'court_costs_included');
  assert.equal(warn.severity, 'warning');
  assert.equal(plan.ok, true);            // Warning does not block the plan.
});

test('remaining Cena greater than amount charged suggests a wrong source column', () => {
  // l_interest (remaining) = 1750, r_charge (charged) = 0; this is impossible.
  const balance = balanceOf({ l_amount: '5000.00', l_interest: '1750.00', r_charge: '0.00' });
  const plan = computePlan({ balance, target: toMinor('1000.00') });
  assert.ok(codes(plan).includes('charge_source_suspicious'));

  // A normal case where part of Cena was repaid does not trigger suspicion.
  const healthy = balanceOf({ l_amount: '5000.00', l_interest: '300.00', r_charge: '500.00' });
  const healthyPlan = computePlan({ balance: healthy, target: toMinor('1000.00') });
  assert.ok(!codes(healthyPlan).includes('charge_source_suspicious'));
  assert.ok(!codes(healthyPlan).includes('debt_mismatch'));
});

test('regression: three credit states reconcile with debt', () => {
  // Three test-booking states exercise r_charge as the charge source.
  const states = [
    {
      label: 'before first write-off (debt 5500.00)',
      columns: {
        l_tax12: '400.00', l_tax11: '300.00', l_tax10: '700.00', l_tax5: '600.00',
        l_tax2: '300.00', l_cinterest: '200.00', l_late_fee: '500.00',
        l_interest: '350.00', r_charge: '350.00', l_amount: '2150.00', writeoff: '1.00',
      },
      debt: '5500.00',
    },
    {
      label: 'after write-off 1000.00 (debt 4500.00)',
      columns: {
        l_tax10: '300.00', l_tax5: '600.00', l_tax2: '300.00',
        l_cinterest: '200.00', l_late_fee: '500.00',
        l_interest: '350.00', r_charge: '350.00', l_amount: '2250.00', writeoff: '1001.00',
      },
      debt: '4500.00',
    },
    {
      label: 'after write-off 2000.00 (debt 2500.00) — r_charge did not decrease',
      columns: {
        l_interest: '0.00', r_charge: '350.00', l_amount: '2500.00', writeoff: '3001.00',
      },
      debt: '2500.00',
    },
  ];

  for (const state of states) {
    const balance = balanceOf(state.columns);
    assert.equal(fromMinor(balance.debt), state.debt, state.label);
    assert.equal(balance.bucketSum, balance.debt, `${state.label}: bucket sum did not reconcile`);
    const plan = computePlan({ balance, target: 0 });
    assert.ok(!codes(plan).includes('debt_mismatch'), `${state.label}: debt_mismatch`);
  }

  // Last state: target 0 writes off principal only.
  const last = computePlan({ balance: balanceOf(states[2].columns), target: 0 });
  assert.equal(fromMinor(last.amount), '2500.00');
  assert.deepEqual(Object.keys(last.allocation), ['amount']);
  assert.equal(last.ok, true);
});

test('prior write-offs are included in warnings', () => {
  const balance = balanceOf({ l_amount: '10000.00', writeoff: '18000.00' });
  const plan = computePlan({ balance, target: toMinor('5000.00') });
  const warn = plan.findings.find((f) => f.code === 'prior_writeoff');
  assert.equal(warn.severity, 'warning');
  assert.equal(plan.ok, true);
});

test('payload contains only nonzero buckets and Decimal strings', () => {
  const balance = balanceOf({ l_tax8: '2000.00', l_amount: '20000.00' });
  const plan = computePlan({ balance, target: toMinor('20000.00') });
  const payload = buildPayload({
    customerId: plan.customerId,
    creditId: plan.creditId,
    allocation: plan.allocation,
    notes: 'demo note',
  });

  assert.deepEqual(payload, {
    customerId: 1001,
    creditId: 2001,
    tax8: '2000.00',
    notes: 'demo note',
  });
  assert.equal(payload.tax1, undefined);
  assert.equal(payload.amount, undefined);
});

test('idempotency key depends on amounts, not the note', () => {
  const balance = balanceOf({ l_tax8: '2000.00', l_amount: '20000.00' });
  const a = computePlan({ balance, target: toMinor('20000.00'), notes: 'first attempt' });
  const b = computePlan({ balance, target: toMinor('20000.00'), notes: 'second attempt' });
  const c = computePlan({ balance, target: toMinor('19000.00') });

  assert.equal(a.idempotencyKey, b.idempotencyKey);
  assert.notEqual(a.idempotencyKey, c.idempotencyKey);
  assert.equal(a.idempotencyKey.length, 32);
});

test('key does not depend on allocation key order', () => {
  const one = idempotencyKey({
    customerId: '1', creditId: '2', debt: 100, target: 0,
    allocation: { tax8: 50, amount: 50 },
  });
  const two = idempotencyKey({
    customerId: '1', creditId: '2', debt: 100, target: 0,
    allocation: { amount: 50, tax8: 50 },
  });
  assert.equal(one, two);
});

test('credit selection does not trust the filter', () => {
  const rows = normalize(assocEnvelope([
    { id: '2999', l_amount: '0.00' },
    { id: '2001', l_amount: '21450.75' },
  ]).data);

  assert.equal(buildBalance(selectCreditRow(rows, '2001')).creditId, '2001');
  assert.throws(() => selectCreditRow(rows, '999999'), /was not found/);
  assert.deepEqual(
    listDebtors(rows).map((d) => d.creditId),
    ['2001'],
  );
});
