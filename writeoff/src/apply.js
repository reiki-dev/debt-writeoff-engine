'use strict';

// ----------------------------------------------------------------------------
// The only place in the module that sends a POST request and moves money.
//
// Rules intentionally enforced strictly:
//   * dry-run is the default. A request is sent only when live: true.
//   * a plan with a blocking guard is not sent; force cannot bypass some guards
//     (see guards.HARD_CODES).
//   * a write-off with the same idempotency key is not sent again.
//   * after success, the balance is reread and checked against target. The API
//     may return success without applying what we requested; verification
//     turns an assumption into a check.
// ----------------------------------------------------------------------------

const { config } = require('./config');
const { call } = require('./client');
const { buildPayload } = require('./plan');
const { fromMinor } = require('./money');
const { hasBlocking, hasUnforgivable } = require('./guards');
const { fetchCreditRows } = require('./exportReader');
const { buildBalance, selectCreditRow } = require('./balance');
const audit = require('./audit');

const WRITEOFF_PATH = '/api/v1.0/special/writeoff';

class WriteoffError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'WriteoffError';
    Object.assign(this, details);
  }
}

async function postWriteoff(payload, { cfg = config, ...rest } = {}) {
  const options = { method: 'POST', cfg, ...rest };
  if (cfg.WRITEOFF_TRANSPORT === 'query') options.query = payload;
  else options.body = payload;

  const envelope = await call(WRITEOFF_PATH, options);
  const data = envelope.data || {};

  if (data.status !== 'success') {
    // errors is an object like { amount: "invalidAmount", charge: "invalidAmount" }
    const perField = data.errors
      ? Object.entries(data.errors).map(([field, keyword]) => `${field}: ${keyword}`).join(', ')
      : '';
    throw new WriteoffError(
      `write-off was not applied: status=${data.status}` +
      `${data.error ? ` error=${data.error}` : ''}` +
      `${perField ? ` (${perField})` : ''}`,
      { data, envelope },
    );
  }

  return { writeoffId: data.writeoffId ?? null, data, envelope };
}

// Rereads the balance and checks it against the expected value.
async function verify({ customerId, creditId, expectedDebt, cfg = config, ...rest }) {
  const { rows } = await fetchCreditRows({ customerId, creditId, cfg, ...rest });
  const balance = buildBalance(selectCreditRow(rows, creditId));
  return {
    ok: balance.debt === expectedDebt,
    debtAfter: balance.debt,
    expectedDebt,
    delta: balance.debt - expectedDebt,
    balance,
  };
}

async function applyPlan(plan, options = {}) {
  const {
    live = false,
    force = false,
    actor = config.ACTOR,
    notes = plan.notes,
    date = null,
    cfg = config,
    auditDir = cfg.AUDIT_DIR,
    skipVerify = false,
    idempotencyGuard = cfg.IDEMPOTENCY_GUARD,
    ...rest
  } = options;

  if (hasUnforgivable(plan.findings)) {
    throw new WriteoffError(
      'plan contains guards that cannot be bypassed with force: ' +
      plan.findings.filter((f) => f.severity === 'error').map((f) => f.code).join(', '),
      { findings: plan.findings },
    );
  }
  if (hasBlocking(plan.findings) && !force) {
    throw new WriteoffError(
      'plan is blocked by guards: ' +
      plan.findings.filter((f) => f.severity === 'error').map((f) => f.code).join(', ') +
      ' (bypass explicitly with force: true)',
      { findings: plan.findings },
    );
  }
  if (plan.amount === 0) {
    throw new WriteoffError('nothing to write off: amount = 0', { plan });
  }

  // Duplicate blocking uses a separate flag, not force. force bypasses data
  // guards; combining this with idempotency would make “allow retry” silently
  // mean “ignore checks” too. Disabled by default; see config.IDEMPOTENCY_GUARD.
  if (idempotencyGuard) {
    const already = await audit.findApplied(plan.idempotencyKey, { dir: auditDir });
    if (already && !force) {
      return {
        status: 'already_applied',
        idempotencyKey: plan.idempotencyKey,
        previous: already,
        message: `this write-off was already applied at ${already.ts} (writeoffId=${already.writeoffId ?? '?'})`,
      };
    }

    const dangling = await audit.findDangling(plan.idempotencyKey, { dir: auditDir });
    if (dangling && !force) {
      return {
        status: 'dangling_intent',
        idempotencyKey: plan.idempotencyKey,
        previous: dangling,
        message:
          `the audit log contains an unfinished attempt from ${dangling.ts}: the request was sent, ` +
          `but its result was not recorded. Check the credit in CRM manually before retrying.`,
      };
    }
  }

  const payload = buildPayload({
    customerId: plan.customerId,
    creditId: plan.creditId,
    allocation: plan.allocation,
    notes,
    date,
  });

  const base = {
    idempotencyKey: plan.idempotencyKey,
    actor,
    customerId: plan.customerId,
    creditId: plan.creditId,
    target: plan.target,
    debtBefore: plan.debtBefore,
    amount: plan.amount,
    allocation: plan.allocation,
  };

  if (!live) {
    return {
      status: 'dry_run',
      idempotencyKey: plan.idempotencyKey,
      payload,
      path: WRITEOFF_PATH,
      transport: cfg.WRITEOFF_TRANSPORT,
      message: `dry-run: request NOT sent. Write-off amount: ${fromMinor(plan.amount)}.`,
    };
  }

  await audit.append({ event: 'intent', ...base, payload }, { dir: auditDir });

  let result;
  try {
    result = await postWriteoff(payload, { cfg, ...rest });
  } catch (err) {
    await audit.append(
      { event: 'failed', ...base, error: err.message, data: err.data ?? null },
      { dir: auditDir },
    );
    throw err;
  }

  await audit.append(
    { event: 'applied', ...base, writeoffId: result.writeoffId },
    { dir: auditDir },
  );

  if (skipVerify) {
    return { status: 'applied', writeoffId: result.writeoffId, verification: null, payload };
  }

  const verification = await verify({
    customerId: plan.customerId,
    creditId: plan.creditId,
    expectedDebt: plan.target,
    cfg,
    ...rest,
  });

  await audit.append(
    {
      event: verification.ok ? 'verified' : 'mismatch',
      ...base,
      writeoffId: result.writeoffId,
      debtAfter: verification.debtAfter,
      delta: verification.delta,
    },
    { dir: auditDir },
  );

  return {
    status: verification.ok ? 'applied' : 'applied_unverified',
    writeoffId: result.writeoffId,
    payload,
    verification,
    message: verification.ok
      ? `write-off applied; debt is now ${fromMinor(verification.debtAfter)}, matching target`
      : `write-off applied (writeoffId=${result.writeoffId}), but debt is now ` +
        `${fromMinor(verification.debtAfter)} instead of ${fromMinor(plan.target)} ` +
        `(difference ${fromMinor(verification.delta)}) — investigate manually`,
  };
}

module.exports = { applyPlan, postWriteoff, verify, WriteoffError, WRITEOFF_PATH };
