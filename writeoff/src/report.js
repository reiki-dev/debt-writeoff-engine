'use strict';

// ----------------------------------------------------------------------------
// Text output is separate so plan/apply return data rather than strings;
// a web interface can render the same plan later.
// ----------------------------------------------------------------------------

const { fromMinor } = require('./money');
const { ORDER, SOURCE_COLUMN } = require('./buckets');

const SEVERITY_MARK = { error: '✗', warning: '!' };

function pad(text, width) {
  const s = String(text);
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function padLeft(text, width) {
  const s = String(text);
  return s.length >= width ? s : ' '.repeat(width - s.length) + s;
}

function formatFindings(findings) {
  if (!findings.length) return ['Guards: clear'];
  const lines = ['Guards:'];
  for (const f of findings) {
    lines.push(`  ${SEVERITY_MARK[f.severity] || '·'} [${f.code}] ${f.message}`);
  }
  return lines;
}

function formatPlan(plan) {
  const lines = [];
  lines.push(`Customer ${plan.customerId}, credit ${plan.creditId}`);
  lines.push(`Current debt:      ${padLeft(fromMinor(plan.debtBefore), 12)}`);
  lines.push(`Target balance:   ${padLeft(fromMinor(plan.target), 12)}`);
  lines.push(`Write-off amount: ${padLeft(fromMinor(plan.amount), 12)}`);
  lines.push(`Bucket capacity:  ${padLeft(fromMinor(plan.capacity), 12)}`);
  if (plan.shortfall > 0) {
    lines.push(`UNALLOCATED:      ${padLeft(fromMinor(plan.shortfall), 12)}`);
  }
  lines.push('');
  lines.push(`${pad('bucket', 12)}${pad('column', 22)}${padLeft('remaining', 12)}${padLeft('write off', 12)}${padLeft('after', 12)}`);
  lines.push('-'.repeat(70));

  for (const bucket of ORDER) {
    const available = plan.buckets[bucket] ?? 0;
    const taken = plan.allocation[bucket] ?? 0;
    if (available === 0 && taken === 0) continue;
    lines.push(
      pad(bucket, 12) +
      pad(SOURCE_COLUMN[bucket], 22) +
      padLeft(fromMinor(available), 12) +
      padLeft(taken ? fromMinor(taken) : '—', 12) +
      padLeft(fromMinor(available - taken), 12),
    );
  }

  lines.push('-'.repeat(70));
  lines.push(
    pad('total', 34) +
    padLeft(fromMinor(plan.capacity), 12) +
    padLeft(fromMinor(plan.allocated), 12) +
    padLeft(fromMinor(plan.debtAfterExpected), 12),
  );
  lines.push('');
  lines.push(...formatFindings(plan.findings));
  lines.push('');
  lines.push(`Idempotency key: ${plan.idempotencyKey}`);
  lines.push(plan.ok ? 'Status: plan can be applied' : 'Status: APPLY BLOCKED');
  return lines.join('\n');
}

function formatApply(result) {
  const lines = [`Result: ${result.status}`];
  if (result.message) lines.push(result.message);
  if (result.writeoffId) lines.push(`writeoffId: ${result.writeoffId}`);
  if (result.payload) {
    lines.push('');
    lines.push('Submitted fields:');
    for (const [key, value] of Object.entries(result.payload)) {
      lines.push(`  ${pad(key, 20)} ${value}`);
    }
  }
  return lines.join('\n');
}

// probe prints all fields used to calculate debt so the column map can be
// visually checked before the first live write-off.
function formatProbe(balance) {
  const lines = [];
  lines.push(`Customer ${balance.customerId}, credit ${balance.creditId}`);
  lines.push(`debt = ${fromMinor(balance.debt)}   (r_debt = ${balance.meta.r_debt ?? '—'})`);
  lines.push('');
  lines.push('Waterfall buckets:');
  for (const bucket of ORDER) {
    lines.push(`  ${pad(bucket, 12)}${pad(SOURCE_COLUMN[bucket], 22)}${padLeft(fromMinor(balance.buckets[bucket] ?? 0), 12)}`);
  }
  lines.push(`  ${pad('TOTAL', 34)}${padLeft(fromMinor(balance.bucketSum), 12)}`);
  lines.push(`  ${pad('debt', 34)}${padLeft(fromMinor(balance.debt), 12)}`);
  lines.push(`  ${pad('difference', 34)}${padLeft(fromMinor(balance.bucketSum - balance.debt), 12)}`);

  const diag = Object.entries(balance.diagnostics || {});
  if (diag.length) {
    lines.push('');
    lines.push('Reference (not included in waterfall or reconciliation):');
    for (const [column, value] of diag) {
      lines.push(`  ${pad(column, 34)}${padLeft(value.raw, 12)}`);
    }
    lines.push('  r_charge — accrued Cena; it does not decrease after a write-off.');
    lines.push('  Remaining Cena is read from l_interest (the charge bucket above).');
  }

  const out = Object.entries(balance.outOfWaterfall);
  lines.push('');
  if (out.length === 0) {
    lines.push('No balances outside the waterfall.');
  } else {
    lines.push('Balances OUTSIDE the waterfall (not included in write-off):');
    for (const [column, value] of out) {
      lines.push(`  ${pad(column, 34)}${padLeft(fromMinor(value), 12)}`);
    }
  }

  if (balance.missingColumns.length) {
    lines.push('');
    lines.push(`Columns missing from export: ${balance.missingColumns.map((m) => m.column).join(', ')}`);
  }

  lines.push('');
  lines.push('Reference fields:');
  for (const [key, value] of Object.entries(balance.meta)) {
    lines.push(`  ${pad(key, 20)} ${value}`);
  }
  return lines.join('\n');
}

module.exports = { formatPlan, formatApply, formatProbe, formatFindings };
