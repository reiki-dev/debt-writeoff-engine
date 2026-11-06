'use strict';

// Cross-version test runner: `node --test "dir/*.test.js"` only expands globs on
// Node 21+, so list the test files explicitly and pass them to `node --test`.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const dirs = ['writeoff/test', 'test'];

const files = dirs.flatMap((dir) => {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) return [];
  return fs
    .readdirSync(abs)
    .filter((name) => name.endsWith('.test.js'))
    .sort()
    .map((name) => path.join(abs, name));
});

if (files.length === 0) {
  process.stderr.write('No test files found.\n');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', cwd: root });
process.exit(result.status === null ? 1 : result.status);
