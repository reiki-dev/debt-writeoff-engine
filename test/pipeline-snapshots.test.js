'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { appendSnapshot, readLatestSnapshots, statusFromSnapshot } = require('../pipeline/src/snapshots');

test('pipeline snapshots append as JSONL and retain the latest record per operation', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-snapshots-'));
  const file = path.join(dir, 'audit', 'pipeline.jsonl');
  try {
    await appendSnapshot(file, {
      operationId: 'op-1', status: 'running', steps: { writeoff: { status: 'active' } },
    });
    await appendSnapshot(file, {
      operationId: 'op-1', status: 'running', steps: { writeoff: { status: 'done', result: { writeoffId: 'w-1' } } },
    });
    await appendSnapshot(file, {
      operationId: 'op-2', status: 'paused', steps: { calendar_confirm: { status: 'active' } },
    });

    const records = (await fs.readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(records.length, 3);
    assert.equal(records[0].event, 'pipeline_snapshot');
    assert.equal(records[0].host, os.hostname());
    const latest = readLatestSnapshots(file);
    assert.equal(latest.get('op-1').steps.writeoff.status, 'done');
    assert.equal(latest.has('op-2'), true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('an unfinished snapshot reports its last active step after restart', () => {
  const recovered = statusFromSnapshot({
    operationId: 'op-3',
    status: 'running',
    steps: {
      writeoff: { status: 'done', result: { writeoffId: 'w-3' } },
      calendar_launch: { status: 'active' },
    },
  });

  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.failedAt, 'calendar_launch');
  assert.match(recovered.error, /Server byl restartován.*calendar_launch/);
  assert.equal(recovered.steps.writeoff.status, 'done');
  assert.equal(recovered.hasCalendarScreenshot, false);
  assert.deepEqual(Object.keys(recovered), [
    'operationId', 'status', 'waitingFor', 'prompt', 'failedAt', 'error', 'steps', 'hasCalendarScreenshot',
  ]);
});
