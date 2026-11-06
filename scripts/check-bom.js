'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const supported = /\.(?:js|md|example)$/i;
let files;
if (process.argv.length > 2) {
  files = process.argv.slice(2);
} else {
  const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'buffer' });
  if (result.status !== 0) {
    process.stderr.write('Unable to list tracked files with git ls-files.\n');
    process.exit(2);
  }
  files = result.stdout.toString('utf8').split('\0').filter(Boolean).filter((file) => supported.test(file));
}

const offenders = [];
for (const file of files) {
  if (!supported.test(file) || !fs.existsSync(file)) continue;
  const buffer = fs.readFileSync(file);
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    offenders.push(path.relative(process.cwd(), file));
  }
}

if (offenders.length) {
  process.stderr.write(`UTF-8 BOM found in:\n${offenders.map((file) => `  ${file}`).join('\n')}\n`);
  process.exit(1);
}
