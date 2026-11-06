#!/usr/bin/env node
'use strict';

// ----------------------------------------------------------------------------
// Offline rehearsal. Runs the same code paths as the CLI with a stub fetch to
// inspect output formatting and guard behavior without contacting a live system.
//
//   node tools/rehearsal.js
//
// This is a developer tool, not part of the module; runtime code does not require it.
// ----------------------------------------------------------------------------

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { normalize } = require('../src/exportReader');
const { buildBalance, listDebtors } = require('../src/balance');
const { computePlan } = require('../src/plan');
const { applyPlan } = require('../src/apply');
const { formatPlan, formatProbe, formatApply } = require('../src/report');
const { toMinor, fromMinor } = require('../src/money');
const { config } = require('../src/config');
const { assocEnvelope, fakeFetch } = require('../test/fixtures');

const cfg = { ...config, API_KEY: 'rehearsal-key' };

// Synthetic credit 2001: buckets reconcile to the reported debt.
const LIVE_CREDIT = {
  id: '2001',
  l_tax10: '800.00',
  l_tax8: '900.00',
  l_tax6: '700.00',
  l_tax5: '500.00',
  l_tax4: '400.00',
  l_tax3: '300.00',
  l_tax2: '200.00',
  l_cinterest: '600.00',
  l_late_fee: '1200.00',
  l_interest: '1200.00',
  r_charge: '1200.00',
  l_amount: '23200.00',
  writeoff: '18000.00',
};

const OTHER_CREDIT = { id: '2999', l_amount: '0.00' };

function head(title) {
  console.log(`\n${'═'.repeat(74)}`);
  console.log(`  ${title}`);
  console.log(`${'═'.repeat(74)}\n`);
}

function balanceOf(overrides) {
  return buildBalance(normalize(assocEnvelope([overrides]).data)[0]);
}

async function main() {
  const auditDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rehearsal-audit-'));

  // ── 1. probe without --credit ────────────────────────────────────────────
  head('probe --customer 1001');
  const rows = normalize(assocEnvelope([OTHER_CREDIT, LIVE_CREDIT]).data);
  const debtors = listDebtors(rows);
  console.log(`Customer 1001: ${rows.length} rows in export, ${debtors.length} with debt`);
  for (const entry of debtors) {
    console.log(`  credit ${entry.creditId}  debt ${fromMinor(entry.debt)}`);
  }

  // ── 2. probe with --credit ───────────────────────────────────────────────
  head('probe --customer 1001 --credit 2001');
  const balance = balanceOf(LIVE_CREDIT);
  console.log(formatProbe(balance));

  // ── 3. preview ───────────────────────────────────────────────────────────
  head('preview --customer 1001 --credit 2001 --target 25000');
  const plan = computePlan({
    balance,
    target: toMinor('25000'),
    notes: 'demo note',
  });
  console.log(formatPlan(plan));

  // ── 4. apply without --live ──────────────────────────────────────────────
  head('apply ... --target 25000        (without --live)');
  const dry = await applyPlan(plan, { cfg, auditDir, fetchImpl: fakeFetch([]) });
  console.log(formatApply(dry));

  // ── 5. apply --live ──────────────────────────────────────────────────────
  head('apply ... --target 25000 --live');
  const afterOk = assocEnvelope([{ ...LIVE_CREDIT, ...zeroed(), l_amount: '25000.00' }]);
  const live = await applyPlan(plan, {
    cfg,
    auditDir,
    live: true,
    actor: 'demo_operator',
    fetchImpl: fakeFetch([
      { status: 200, data: { writeoffId: '81495', status: 'success' } },
      afterOk,
    ]),
  });
  console.log(formatApply(live));

  // ── 6. retry the same operation ──────────────────────────────────────────
  head('apply ... --live        (retry; same plan is allowed by default)');
  const again = await applyPlan(plan, {
    cfg,
    auditDir,
    live: true,
    fetchImpl: fakeFetch([
      { status: 200, data: { writeoffId: '81496', status: 'success' } },
      afterOk,
    ]),
  });
  console.log(formatApply(again));
  console.log('\nIdempotency blocking is disabled: CRM itself rejects');
  console.log('the same write-off twice and returns invalidAmount.');

  // ── 6b. same operation with the guard enabled ────────────────────────────
  head('apply ... --live        (retry, CRM_IDEMPOTENCY_GUARD=true)');
  const refused = await applyPlan(plan, {
    cfg, auditDir, live: true, idempotencyGuard: true, fetchImpl: fakeFetch([]),
  });
  console.log(formatApply(refused));

  // ── 7. blocked plan ──────────────────────────────────────────────────────
  head('preview on a credit where bucket sum does not match debt');
  const broken = balanceOf({ id: '999', l_amount: '10000.00', l_interest: '480.00', debt: '10480.00' });
  console.log(formatPlan(computePlan({ balance: broken, target: toMinor('5000') })));

  // ── 8. API returned success, but debt did not reconcile ──────────────────
  head('apply --live, but debt does not equal target after the write-off');
  const planB = computePlan({ balance: balanceOf({ ...LIVE_CREDIT, id: '777' }), target: toMinor('25000') });
  const afterBad = assocEnvelope([{ ...LIVE_CREDIT, id: '777', ...zeroed(), l_amount: '26000.00' }]);
  const bad = await applyPlan(planB, {
    cfg,
    auditDir,
    live: true,
    fetchImpl: fakeFetch([
      { status: 200, data: { writeoffId: '81496', status: 'success' } },
      afterBad,
    ]),
  });
  console.log(formatApply(bad));

  // ── 9. audit log ─────────────────────────────────────────────────────────
  head('audit log for the rehearsal');
  const log = await fsp.readFile(path.join(auditDir, 'writeoff.jsonl'), 'utf8');
  for (const line of log.trim().split('\n')) {
    const e = JSON.parse(line);
    console.log(`${e.ts}  ${String(e.event).padEnd(9)} credit=${e.creditId} ` +
      `amount=${e.amount !== undefined ? fromMinor(e.amount) : '—'} ` +
      `${e.writeoffId ? `writeoffId=${e.writeoffId}` : ''}` +
      `${e.debtAfter !== undefined ? ` debtAfter=${fromMinor(e.debtAfter)}` : ''}`);
  }

  await fsp.rm(auditDir, { recursive: true, force: true });
}

// After the write-off, all buckets except principal are cleared. r_charge does
// NOT change: it is the amount charged, not the remaining balance (see src/buckets.js).
function zeroed() {
  const out = {};
  for (let i = 1; i <= 12; i += 1) out[`l_tax${i}`] = '0.00';
  out.l_cinterest = '0.00';
  out.l_late_fee = '0.00';
  out.l_interest = '0.00';
  return out;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
