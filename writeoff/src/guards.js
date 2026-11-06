'use strict';

// ----------------------------------------------------------------------------
// Guards are small checks that return findings with a code.
//
// severity:
//   'error'   — apply is blocked (without --force; some cannot be bypassed)
//   'warning' — apply is allowed, but the operator should see it in the report
//
// The main guard is debt_mismatch. It protects against an incorrect column map:
// if the balances in our 16 buckets do not sum to system debt, the module's
// debt model differs from the CRM's, so no write-off should be sent regardless
// of how plausible the allocation looks.
// ----------------------------------------------------------------------------

const { fromMinor } = require('./money');
const { API_UNSUPPORTED, SOURCE_COLUMN } = require('./buckets');

const HARD_CODES = new Set(['debt_mismatch', 'api_unsupported_bucket', 'target_invalid']);

function finding(code, severity, message, data = {}) {
  return { code, severity, message, data };
}

function evaluate({ balance, target, allocation, shortfall, tolerance = 0 }) {
  const out = [];
  const alloc = allocation || {};

  // --- input ----------------------------------------------------------------
  if (!Number.isInteger(target) || target < 0) {
    out.push(finding('target_invalid', 'error',
      `target must be a non-negative integer in haléře, received ${target}`));
  }

  // --- reconcile with system debt ------------------------------------------
  const delta = balance.bucketSum - balance.debt;
  if (Math.abs(delta) > tolerance) {
    const parts = [];
    for (const [column, value] of Object.entries(balance.outOfWaterfall)) {
      parts.push(`${column}=${fromMinor(value)}`);
    }
    const hint = parts.length
      ? ` Balances outside the waterfall were found: ${parts.join(', ')} — debt may include more than our buckets.`
      : ' No balances outside the waterfall were found — the column map in src/buckets.js may be incomplete.';

    out.push(finding('debt_mismatch', 'error',
      `bucket balance sum ${fromMinor(balance.bucketSum)} does not equal system debt ` +
      `${fromMinor(balance.debt)} (difference ${fromMinor(delta)}).${hint}`,
      { bucketSum: balance.bucketSum, debt: balance.debt, delta, outOfWaterfall: balance.outOfWaterfall }));
  }

  if (balance.missingColumns.length) {
    out.push(finding('missing_columns', 'warning',
      `columns missing from export: ${balance.missingColumns.map((m) => m.column).join(', ')} — ` +
      `the corresponding buckets are treated as zero`,
      { missing: balance.missingColumns }));
  }

  // --- amount to write off --------------------------------------------------
  if (balance.debt <= target) {
    out.push(finding('nothing_to_write_off', 'error',
      `debt ${fromMinor(balance.debt)} is already at or below target ${fromMinor(target)} — nothing to write off`,
      { debt: balance.debt, target }));
  }

  if (shortfall > 0) {
    out.push(finding('insufficient_capacity', 'error',
      `insufficient bucket capacity: could not allocate ${fromMinor(shortfall)} — ` +
      `target ${fromMinor(target)} cannot be reached for this credit`,
      { shortfall, target }));
  }

  // --- API limitations ------------------------------------------------------
  const blocked = API_UNSUPPORTED.filter((bucket) => (alloc[bucket] ?? 0) > 0);
  if (blocked.length) {
    out.push(finding('api_unsupported_bucket', 'error',
      `waterfall allocated amounts to buckets without fields in the special/writeoff contract: ` +
      `${blocked.map((b) => `${b}=${fromMinor(alloc[b])}`).join(', ')}. ` +
      `The postWriteoff() specification accepts only tax1..tax10, so this write-off cannot be sent.`,
      { buckets: blocked }));
  }

  // --- findings the operator should know about -----------------------------
  const court = ['tax9', 'tax10'].filter((bucket) => (alloc[bucket] ?? 0) > 0);
  if (court.length) {
    out.push(finding('court_costs_included', 'warning',
      `court costs are included in the write-off: ${court.map((b) => `${b}=${fromMinor(alloc[b])}`).join(', ')}`,
      { buckets: court }));
  }

  // Cena invariant: the remaining balance cannot exceed the amount charged.
  // This catches a wrong source column: r_charge looked like a balance until
  // part of the Cena had been repaid, when the two values diverged.
  const chargeRemaining = balance.buckets.charge ?? 0;
  const chargeTotal = balance.diagnostics?.r_charge?.minor;
  if (chargeTotal !== null && chargeTotal !== undefined && chargeRemaining > chargeTotal) {
    out.push(finding('charge_source_suspicious', 'warning',
      `remaining Cena (${SOURCE_COLUMN.charge} = ${fromMinor(chargeRemaining)}) exceeds the amount charged ` +
      `(r_charge = ${fromMinor(chargeTotal)}). The charge source column may be incorrect — ` +
      `check it with probe before sending the write-off.`,
      { chargeColumn: SOURCE_COLUMN.charge, chargeRemaining, chargeTotal }));
  }

  const priorWriteoff = String(balance.meta.writeoff ?? '0');
  if (priorWriteoff && Number(priorWriteoff) > 0) {
    out.push(finding('prior_writeoff', 'warning',
      `the credit has prior write-offs (writeoff=${priorWriteoff}) — make sure this is not a duplicate`,
      { writeoff: priorWriteoff }));
  }

  const rDebt = balance.meta.r_debt;
  if (rDebt !== undefined && String(rDebt) !== '' && Number(rDebt) !== Number(fromMinor(balance.debt))) {
    out.push(finding('debt_r_debt_mismatch', 'warning',
      `debt=${fromMinor(balance.debt)} and r_debt=${rDebt} differ`,
      { debt: fromMinor(balance.debt), rDebt }));
  }

  for (const [column, label] of [['sold', 'credit is sold'], ['archive', 'credit is archived']]) {
    const value = balance.meta[column];
    if (value === undefined) continue;
    const isSet = !(value === '' || value === '0' || value === 0 || /^0000-00-00/.test(String(value)));
    if (isSet) {
      out.push(finding(`flag_${column}`, 'warning', `${label} (${column}=${value})`, { [column]: value }));
    }
  }

  return out;
}

function hasBlocking(findings) {
  return findings.some((f) => f.severity === 'error');
}

// Guards that cannot be bypassed with --force indicate that the module cannot
// interpret the data, rather than an operator choosing to accept a known risk.
function hasUnforgivable(findings) {
  return findings.some((f) => f.severity === 'error' && HARD_CODES.has(f.code));
}

module.exports = { evaluate, hasBlocking, hasUnforgivable, HARD_CODES };
