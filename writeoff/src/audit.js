'use strict';

// ----------------------------------------------------------------------------
// Audit is append-only JSONL. One operation can produce several records:
//   intent   -> request is about to be sent (written BEFORE the request)
//   applied  -> API returned success
//   failed   -> API returned failed or the request threw an error
//   verified -> balance reread; debt now equals target
//   mismatch -> balance reread; debt does NOT equal target
//
// Writing intent before the request matters: if the process stops between
// sending the request and receiving its response, the log shows an unfinished
// operation instead of making it appear that nothing happened.
//
// Idempotency is tracked here because the configured balance export has no
// field that reliably indicates whether a specific write-off was applied.
// ----------------------------------------------------------------------------

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { config } = require('./config');

const FILE = 'writeoff.jsonl';
// Cache is scoped to the resolved audit directory so independent runs/tests do
// not share state. Each value keeps the parsed log as well as its key index.
const indexes = new Map();

function directoryKey(dir) {
  return path.resolve(dir);
}

function indexEntries(entries) {
  const byKey = new Map();
  for (const entry of entries) {
    if (entry.idempotencyKey === undefined) continue;
    const matches = byKey.get(entry.idempotencyKey) || [];
    matches.push(entry);
    byKey.set(entry.idempotencyKey, matches);
  }
  return byKey;
}

function auditPath(dir) {
  return path.join(dir, FILE);
}

async function append(entry, { dir = config.AUDIT_DIR } = {}) {
  await fsp.mkdir(dir, { recursive: true });
  const record = {
    ts: new Date().toISOString(),
    host: os.hostname(),
    pid: process.pid,
    ...entry,
  };
  // flag 'a' + one line = atomic append within the writing process
  await fsp.appendFile(auditPath(dir), `${JSON.stringify(record)}\n`, 'utf8');
  const cached = indexes.get(directoryKey(dir));
  if (cached) {
    cached.entries.push(record);
    if (record.idempotencyKey !== undefined) {
      const matches = cached.byKey.get(record.idempotencyKey) || [];
      matches.push(record);
      cached.byKey.set(record.idempotencyKey, matches);
    }
  }
  return record;
}

async function readAll({ dir = config.AUDIT_DIR } = {}) {
  const file = auditPath(dir);
  let text = '';
  if (fs.existsSync(file)) text = await fsp.readFile(file, 'utf8');
  const out = [];
  for (const [i, line] of text.split('\n').entries()) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A malformed line does not invalidate the whole log, but is not hidden.
      out.push({ ts: null, event: 'corrupt_line', line: i + 1, raw: line.slice(0, 500) });
    }
  }
  indexes.set(directoryKey(dir), { entries: out, byKey: indexEntries(out) });
  return out;
}

async function getIndex({ dir = config.AUDIT_DIR } = {}) {
  const key = directoryKey(dir);
  let cached = indexes.get(key);
  if (!cached) {
    await readAll({ dir });
    cached = indexes.get(key);
  }
  return cached;
}

// Everything known about this idempotency key.
async function history(key, opts = {}) {
  const index = await getIndex(opts);
  return [...(index.byKey.get(key) || [])];
}

// Whether a write-off with this key has already succeeded.
async function findApplied(key, opts = {}) {
  const entries = await history(key, opts);
  return entries.find((entry) => entry.event === 'applied') || null;
}

// Whether there is an unfinished intent (sent, but no result received).
async function findDangling(key, opts = {}) {
  const entries = await history(key, opts);
  const intents = entries.filter((entry) => entry.event === 'intent');
  if (intents.length === 0) return null;
  const closed = entries.some((entry) => ['applied', 'failed'].includes(entry.event));
  return closed ? null : intents[intents.length - 1];
}

module.exports = { append, readAll, history, findApplied, findDangling, auditPath };
