'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function appendSnapshot(file, snapshot) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const record = {
    ts: new Date().toISOString(),
    host: os.hostname(),
    pid: process.pid,
    event: 'pipeline_snapshot',
    ...snapshot,
  };
  await fsp.appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

function readLatestSnapshots(file) {
  const latest = new Map();
  if (!fs.existsSync(file)) return latest;

  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record.event === 'pipeline_snapshot' && record.operationId && record.steps) {
        latest.set(record.operationId, record);
      }
    } catch {
      // Ignore a partial/corrupt line and keep the most recent valid snapshot.
    }
  }
  return latest;
}

function statusFromSnapshot(snapshot) {
  const state = {
    operationId: snapshot.operationId,
    status: snapshot.status,
    waitingFor: snapshot.waitingFor || null,
    prompt: snapshot.prompt || null,
    failedAt: snapshot.failedAt || null,
    error: snapshot.error || null,
    steps: snapshot.steps,
    hasCalendarScreenshot: false,
  };
  if (state.status === 'running' || state.status === 'paused') {
    const interruptedAt = state.waitingFor || Object.keys(state.steps)
      .find((name) => state.steps[name].status === 'active') || null;
    state.status = 'failed';
    state.failedAt = interruptedAt;
    state.error = `Server byl restartován během kroku "${interruptedAt || 'neznámý krok'}". Operaci nelze obnovit; ověřte audit odpisu.`;
  }
  return state;
}

module.exports = { appendSnapshot, readLatestSnapshots, statusFromSnapshot };
