'use strict';

const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const path = require('node:path');

const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  stdio: 'inherit',
  env: {
    ...process.env,
    MOCK_MODE: 'true',
    JWT_SECRET: randomBytes(32).toString('hex'),
  },
});

child.on('error', (error) => {
  process.stderr.write(`Could not start demo server: ${error.message}\n`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code === null ? 1 : code;
});
