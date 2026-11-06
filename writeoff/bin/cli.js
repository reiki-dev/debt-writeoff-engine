#!/usr/bin/env node
'use strict';

// ----------------------------------------------------------------------------
// CLI for the write-off module. This is its user interface.
//
//   probe    --customer 1001 [--credit 2001]
//   preview  --customer 1001 --credit 2001 --target 25000
//   apply    --customer 1001 --credit 2001 --target 25000 [--live]
//   history  --key <idempotencyKey>
//
// apply without --live sends nothing and prints the prepared request body.
// ----------------------------------------------------------------------------

const {
  config, assertUsable, fetchCreditRows, buildBalance, selectCreditRow, listDebtors,
  buildPlan, applyPlan, audit, formatPlan, formatApply, formatProbe, money,
} = require('../src');

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const name = token.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[name] = true;
    } else {
      flags[name] = next;
      i += 1;
    }
  }
  return { command, flags };
}

function required(flags, name) {
  const value = flags[name];
  if (value === undefined || value === true || value === '') {
    throw new Error(`--${name} is required`);
  }
  return value;
}

const USAGE = `
fintech-writeoff — write off debt using the bucket hierarchy

  probe    --customer <id> [--credit <id>]              show balances and reconciliation with debt
  preview  --customer <id> --credit <id> --target <Kč>  preview allocation; sends nothing
  apply    --customer <id> --credit <id> --target <Kč>  apply a write-off
             [--live]        send the request (without this flag: dry-run)
             [--force]       bypass eligible guards / retry a write-off
             [--notes "..."] write-off note
             [--no-verify]   do not reread the balance after the write-off
  history  --key <key>                                  audit records for the key

Environment:
  CRM_API_KEY            API key (required)
  CRM_BASE_URL           ${config.BASE_URL}
  CRM_EXPORT_ID          ${config.EXPORT_ID}
  CRM_AUTH_MODE          ${config.AUTH_MODE}   (header|query)
  CRM_WRITEOFF_TRANSPORT ${config.WRITEOFF_TRANSPORT}     (body|query)
  CRM_ACTOR              operator name for notes and audit log
  CRM_AUDIT_DIR          ${config.AUDIT_DIR}
  CRM_DEBT_TOLERANCE     ${config.DEBT_TOLERANCE_MINOR}        reconciliation tolerance, haléře
`.trim();

async function cmdProbe(flags) {
  const customerId = required(flags, 'customer');
  const creditId = flags.credit && flags.credit !== true ? flags.credit : null;

  const { rows } = await fetchCreditRows({ customerId, creditId });

  if (!creditId) {
    const debtors = listDebtors(rows);
    console.log(`Customer ${customerId}: ${rows.length} rows in export, ${debtors.length} with debt`);
    for (const entry of debtors) {
      console.log(`  credit ${entry.creditId}  debt ${money.fromMinor(entry.debt)}`);
    }
    if (debtors.length) console.log('\nRun probe with --credit <id> to inspect the bucket balances.');
    return;
  }

  console.log(formatProbe(buildBalance(selectCreditRow(rows, creditId))));
}

async function cmdPreview(flags) {
  const plan = await buildPlan({
    customerId: required(flags, 'customer'),
    creditId: required(flags, 'credit'),
    target: required(flags, 'target'),
    notes: flags.notes && flags.notes !== true ? flags.notes : '',
  });
  console.log(formatPlan(plan));
  return plan;
}

async function cmdApply(flags) {
  const plan = await cmdPreview(flags);
  console.log(`\n${'='.repeat(70)}\n`);

  const live = flags.live === true;
  if (!live) {
    console.log('Dry-run mode (--live not set). The request will NOT be sent.\n');
  }

  const result = await applyPlan(plan, {
    live,
    force: flags.force === true,
    notes: flags.notes && flags.notes !== true ? flags.notes : plan.notes,
    skipVerify: flags['no-verify'] === true,
  });

  console.log(formatApply(result));
  if (['dangling_intent', 'applied_unverified'].includes(result.status)) process.exitCode = 2;
}

async function cmdHistory(flags) {
  const entries = await audit.history(required(flags, 'key'));
  if (!entries.length) {
    console.log('No records found for this key.');
    return;
  }
  for (const entry of entries) {
    console.log(`${entry.ts}  ${entry.event}  ${JSON.stringify(entry)}`);
  }
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));

  if (!command || flags.help || command === 'help') {
    console.log(USAGE);
    return;
  }

  const needsKey = ['probe', 'preview', 'apply'].includes(command);
  if (needsKey) assertUsable();

  switch (command) {
    case 'probe': return cmdProbe(flags);
    case 'preview': return cmdPreview(flags).then(() => undefined);
    case 'apply': return cmdApply(flags);
    case 'history': return cmdHistory(flags);
    default:
      throw new Error(`unknown command "${command}". ${'\n'}${USAGE}`);
  }
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  if (process.env.CRM_DEBUG) console.error(err);
  process.exitCode = 1;
});
