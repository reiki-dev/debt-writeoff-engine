'use strict';

// ----------------------------------------------------------------------------
// A write-off plan answers “what exactly will be written off, and why?”
//
// It is built in two distinct steps:
//   computePlan()  — pure function of Balance; no network, time, or files.
//   buildPlan()    — reads the export and calls computePlan().
//
// Nothing is sent here: the plan can be inspected, logged, and stored safely.
// ----------------------------------------------------------------------------

const crypto = require('node:crypto');

const { config } = require('./config');
const { ORDER, SOURCE_COLUMN, PAYLOAD_FIELD } = require('./buckets');
const { allocate } = require('./waterfall');
const { evaluate, hasBlocking, hasUnforgivable } = require('./guards');
const { fromMinor, toMinor } = require('./money');
const exportReader = require('./exportReader');
const { buildBalance, selectCreditRow } = require('./balance');

// Idempotency key: the same write-off for one credit must not be sent twice.
// The hash includes everything that determines its monetary effect, but not
// notes or date, so changing the note does not create a new write-off.
function idempotencyKey({ customerId, creditId, debt, target, allocation }) {
  const canonical = JSON.stringify({
    customerId: String(customerId),
    creditId: String(creditId),
    debt,
    target,
    allocation: Object.fromEntries(
      Object.entries(allocation).sort(([a], [b]) => a.localeCompare(b)),
    ),
  });
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

// Request body for special/writeoff. Kept separate so it can be tested without
// sending anything.
function buildPayload({ customerId, creditId, allocation, notes, date }) {
  const payload = {
    customerId: Number(customerId),
    creditId: Number(creditId),
  };

  // The body is built by iterating ORDER. A bucket missing from ORDER would be
  // silently omitted, sending a smaller amount than the plan shows. Check this
  // explicitly.
  const unknown = Object.keys(allocation).filter((bucket) => !ORDER.includes(bucket));
  if (unknown.length) {
    throw new Error(`allocation contains buckets outside the hierarchy: ${unknown.join(', ')}`);
  }

  for (const bucket of ORDER) {
    const minor = allocation[bucket] ?? 0;
    if (minor === 0) continue;
    const field = PAYLOAD_FIELD[bucket];
    if (field === undefined) {
      // This should be caught earlier by api_unsupported_bucket, but fail loudly
      // instead of sending a write-off missing part of the amount.
      throw new Error(`bucket ${bucket} has no field in the writeoff contract`);
    }
    payload[field] = fromMinor(minor);
  }

  if (notes) payload.notes = notes;
  if (date) payload.date = date;
  return payload;
}

// target is an integer in haléře (how much debt should REMAIN).
function computePlan({ balance, target, notes = '', tolerance = config.DEBT_TOLERANCE_MINOR }) {
  const amount = Math.max(balance.debt - target, 0);
  const { allocation, allocated, shortfall, steps, capacity } = allocate({
    buckets: balance.buckets,
    order: ORDER,
    amount,
  });

  const findings = evaluate({ balance, target, allocation, shortfall, tolerance });

  return {
    customerId: balance.customerId,
    creditId: balance.creditId,
    debtBefore: balance.debt,
    target,
    amount,
    allocated,
    shortfall,
    capacity,
    debtAfterExpected: balance.debt - allocated,
    allocation,
    steps,
    buckets: balance.buckets,
    sourceColumns: SOURCE_COLUMN,
    notes,
    findings,
    ok: !hasBlocking(findings),
    fatal: hasUnforgivable(findings),
    idempotencyKey: idempotencyKey({
      customerId: balance.customerId,
      creditId: balance.creditId,
      debt: balance.debt,
      target,
      allocation,
    }),
  };
}

// target is specified in crowns as a string ("25000", "25000.00") or number (25000).
// To pass an already converted value, use targetMinor. Mixing crowns and haléře
// in one parameter is an easy way to write off one hundred times the intended amount.
async function buildPlan({
  customerId, creditId, target, targetMinor, notes = '', cfg = config, ...rest
} = {}) {
  if ((target === undefined) === (targetMinor === undefined)) {
    throw new Error('specify exactly one: target (in Kč) or targetMinor (in haléře)');
  }
  const resolvedTarget = targetMinor === undefined ? toMinor(target, 'target') : targetMinor;
  if (!Number.isInteger(resolvedTarget)) {
    throw new Error(`targetMinor must be an integer, received ${targetMinor}`);
  }

  const { rows } = await exportReader.fetchCreditRows({ customerId, creditId, cfg, ...rest });
  const row = selectCreditRow(rows, creditId);
  const balance = buildBalance(row);

  return computePlan({
    balance,
    target: resolvedTarget,
    notes,
    tolerance: cfg.DEBT_TOLERANCE_MINOR,
  });
}

module.exports = { buildPlan, computePlan, buildPayload, idempotencyKey };
