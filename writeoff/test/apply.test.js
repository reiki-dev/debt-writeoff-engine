'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { normalize } = require('../src/exportReader');
const { buildBalance } = require('../src/balance');
const { computePlan } = require('../src/plan');
const { applyPlan, WriteoffError } = require('../src/apply');
const audit = require('../src/audit');
const { toMinor } = require('../src/money');
const { config } = require('../src/config');
const { assocEnvelope, fakeFetch } = require('./fixtures');

const cfg = { ...config, API_KEY: 'test-key', AUDIT_DIR: null };

async function tmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'writeoff-audit-'));
}

function planFor(overrides, target) {
  const rows = normalize(assocEnvelope([overrides]).data);
  return computePlan({ balance: buildBalance(rows[0]), target: toMinor(target) });
}

const OK_WRITEOFF = { status: 200, data: { writeoffId: '81495', status: 'success' } };

test('dry-run sends no requests', async () => {
  const dir = await tmpDir();
  const fetchImpl = fakeFetch([]);
  const plan = planFor({ l_tax8: '2000.00', l_amount: '20000.00' }, '20000.00');

  const result = await applyPlan(plan, { cfg, auditDir: dir, fetchImpl });

  assert.equal(result.status, 'dry_run');
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(result.payload.tax8, '2000.00');
  assert.deepEqual(await audit.readAll({ dir }), []);   // and writes nothing to the audit log
});

test('audit history indexes a directory and reuses it for later lookups', async () => {
  const dir = await tmpDir();
  const key = 'same-idempotency-key';
  await audit.append({ event: 'intent', idempotencyKey: key }, { dir });
  await audit.append({ event: 'applied', idempotencyKey: key }, { dir });

  const originalReadFile = fsp.readFile;
  let reads = 0;
  fsp.readFile = function (...args) {
    reads += 1;
    return originalReadFile.apply(this, args);
  };
  try {
    assert.equal(reads, 0);
    assert.equal((await audit.history(key, { dir })).length, 2);
    assert.equal(reads, 1); // First lookup loads the JSONL once.
    assert.equal((await audit.history(key, { dir })).length, 2);
    assert.equal(reads, 1); // Later lookups use the in-memory index.
  } finally {
    fsp.readFile = originalReadFile;
  }
});

test('live write-off sends POST, writes audit, and verifies the balance', async () => {
  const dir = await tmpDir();
  const plan = planFor({ l_tax8: '2000.00', l_amount: '20000.00' }, '20000.00');
  // Only principal remains in the system after the write-off.
  const after = assocEnvelope([{ l_amount: '20000.00' }]);
  const fetchImpl = fakeFetch([OK_WRITEOFF, after]);

  const result = await applyPlan(plan, { cfg, auditDir: dir, live: true, fetchImpl, actor: 'demo_operator' });

  assert.equal(result.status, 'applied');
  assert.equal(result.writeoffId, '81495');
  assert.equal(result.verification.ok, true);

  const [writeoffCall, verifyCall] = fetchImpl.calls;
  assert.match(writeoffCall.url, /\/api\/v1\.0\/special\/writeoff/);
  assert.equal(writeoffCall.init.method, 'POST');
  assert.deepEqual(JSON.parse(writeoffCall.init.body), {
    customerId: 1001, creditId: 2001, tax8: '2000.00',
  });
  assert.equal(writeoffCall.init.headers['x-api-key'], 'test-key');
  assert.match(verifyCall.url, /export\/export/);

  const events = (await audit.readAll({ dir })).map((e) => e.event);
  assert.deepEqual(events, ['intent', 'applied', 'verified']);
});

test('intent is written BEFORE the request so a crash is not lost', async () => {
  const dir = await tmpDir();
  const plan = planFor({ l_amount: '10000.00' }, '5000.00');
  const fetchImpl = async () => { throw new Error('connection was interrupted'); };

  await assert.rejects(
    () => applyPlan(plan, { cfg, auditDir: dir, live: true, fetchImpl }),
    /connection was interrupted/,
  );

  const events = (await audit.readAll({ dir })).map((e) => e.event);
  assert.deepEqual(events, ['intent', 'failed']);
});

test('retries are allowed by default; the upstream system handles rejection', async () => {
  // CRM rejects applying the same write-off twice, so by default the module
  // sends the request and lets CRM return its response.
  const dir = await tmpDir();
  const plan = planFor({ l_amount: '10000.00' }, '5000.00');
  const after = assocEnvelope([{ l_amount: '5000.00' }]);

  const first = await applyPlan(plan, {
    cfg, auditDir: dir, live: true, fetchImpl: fakeFetch([OK_WRITEOFF, after]),
  });
  assert.equal(first.status, 'applied');

  const secondFetch = fakeFetch([
    { status: 200, data: { writeoffId: '81496', status: 'success' } }, after,
  ]);
  const second = await applyPlan(plan, { cfg, auditDir: dir, live: true, fetchImpl: secondFetch });

  assert.equal(second.status, 'applied');
  assert.equal(secondFetch.calls.length, 2);

  // Both write-offs remain in the audit log.
  const events = (await audit.readAll({ dir })).map((e) => e.event);
  assert.deepEqual(events, ['intent', 'applied', 'verified', 'intent', 'applied', 'verified']);
});

test('with the guard enabled, an unfinished attempt blocks a retry', async () => {
  const dir = await tmpDir();
  const plan = planFor({ l_amount: '10000.00' }, '5000.00');
  await audit.append({ event: 'intent', idempotencyKey: plan.idempotencyKey }, { dir });

  const result = await applyPlan(plan, {
    cfg, auditDir: dir, live: true, idempotencyGuard: true, fetchImpl: fakeFetch([]),
  });

  assert.equal(result.status, 'dangling_intent');
  assert.match(result.message, /request was sent/);
});

test('with the guard enabled, a repeated write-off is not sent twice', async () => {
  const dir = await tmpDir();
  const plan = planFor({ l_amount: '10000.00' }, '5000.00');
  const after = assocEnvelope([{ l_amount: '5000.00' }]);

  const first = await applyPlan(plan, {
    cfg, auditDir: dir, live: true, idempotencyGuard: true,
    fetchImpl: fakeFetch([OK_WRITEOFF, after]),
  });
  assert.equal(first.status, 'applied');

  const secondFetch = fakeFetch([]);
  const second = await applyPlan(plan, {
    cfg, auditDir: dir, live: true, idempotencyGuard: true, fetchImpl: secondFetch,
  });

  assert.equal(second.status, 'already_applied');
  assert.equal(secondFetch.calls.length, 0);
  assert.equal(second.previous.writeoffId, '81495');
});

test('data.status=failed is an error despite HTTP 200 and status 200', async () => {
  const dir = await tmpDir();
  const plan = planFor({ l_amount: '10000.00' }, '5000.00');
  const failed = {
    status: 200,
    data: { status: 'failed', errors: { amount: 'invalidAmount' } },
  };

  await assert.rejects(
    () => applyPlan(plan, { cfg, auditDir: dir, live: true, fetchImpl: fakeFetch([failed]) }),
    (err) => {
      assert.ok(err instanceof WriteoffError);
      assert.match(err.message, /amount: invalidAmount/);
      return true;
    },
  );

  const events = (await audit.readAll({ dir })).map((e) => e.event);
  assert.deepEqual(events, ['intent', 'failed']);
});

test('API success with an unexpected balance is marked applied_unverified', async () => {
  const dir = await tmpDir();
  const plan = planFor({ l_tax8: '2000.00', l_amount: '20000.00' }, '20000.00');
  // API returned success, but the debt did not reach the target.
  const after = assocEnvelope([{ l_amount: '21000.00' }]);

  const result = await applyPlan(plan, {
    cfg, auditDir: dir, live: true, fetchImpl: fakeFetch([OK_WRITEOFF, after]),
  });

  assert.equal(result.status, 'applied_unverified');
  assert.equal(result.verification.ok, false);
  assert.match(result.message, /instead of/);

  const events = (await audit.readAll({ dir })).map((e) => e.event);
  assert.deepEqual(events, ['intent', 'applied', 'mismatch']);
});

test('hard guards cannot be bypassed with force', async () => {
  const dir = await tmpDir();
  const plan = planFor(
    { l_amount: '10000.00', l_administrative_fee: '480.00', debt: '10480.00' },
    '5000.00',
  );
  assert.equal(plan.fatal, true);

  await assert.rejects(
    () => applyPlan(plan, { cfg, auditDir: dir, live: true, force: true, fetchImpl: fakeFetch([]) }),
    /cannot be bypassed with force/,
  );
});

test('force bypasses the idempotency block when enabled', async () => {
  const dir = await tmpDir();
  const plan = planFor({ l_amount: '10000.00' }, '5000.00');
  const after = assocEnvelope([{ l_amount: '5000.00' }]);

  await applyPlan(plan, {
    cfg, auditDir: dir, live: true, idempotencyGuard: true,
    fetchImpl: fakeFetch([OK_WRITEOFF, after]),
  });

  const repeatFetch = fakeFetch([{ status: 200, data: { writeoffId: '81496', status: 'success' } }, after]);
  const repeat = await applyPlan(plan, {
    cfg, auditDir: dir, live: true, idempotencyGuard: true, force: true, fetchImpl: repeatFetch,
  });

  assert.equal(repeat.status, 'applied');
  assert.equal(repeat.writeoffId, '81496');
  assert.equal(repeatFetch.calls.length, 2);
});

test('a zero amount is not sent even with force', async () => {
  const dir = await tmpDir();
  const nothingToDo = computePlan({
    balance: buildBalance(normalize(assocEnvelope([{ l_amount: '1000.00' }]).data)[0]),
    target: toMinor('1000.00'),
  });

  await assert.rejects(
    () => applyPlan(nothingToDo, {
      cfg, auditDir: dir, live: true, force: true, fetchImpl: fakeFetch([]),
    }),
    /nothing to write off/,
  );
});
