'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

test('server creates demo users in a missing configured users file', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-users-'));
  const usersFile = path.join(tempDir, 'users.json');
  const repoUsersFile = path.join(root, 'users.json');
  const repoUsersExisted = fs.existsSync(repoUsersFile);
  const repoUsersBefore = repoUsersExisted ? fs.readFileSync(repoUsersFile) : null;
  const demoUsers = fs.readFileSync(path.join(root, 'users.demo.json'));
  const port = await unusedPort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      MOCK_MODE: 'true',
      JWT_SECRET: 'demo-users-test-secret-is-at-least-32-characters',
      USERS_FILE: usersFile,
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });

  try {
    const started = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Server did not start. stdout: ${stdout}\nstderr: ${stderr}`)), 10000);
      child.stdout.on('data', () => {
        if (stdout.includes(`http://localhost:${port}`)) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once('error', error => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', code => {
        clearTimeout(timer);
        reject(new Error(`Server exited with code ${code}. stdout: ${stdout}\nstderr: ${stderr}`));
      });
    });
    assert.equal(started, undefined);
    assert.match(stdout, new RegExp(`Demo users created at ${usersFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.deepEqual(fs.readFileSync(usersFile), demoUsers);
    assert.equal(fs.existsSync(repoUsersFile), repoUsersExisted);
    if (repoUsersExisted) assert.deepEqual(fs.readFileSync(repoUsersFile), repoUsersBefore);
  } finally {
    child.kill();
    await new Promise(resolve => child.once('exit', resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
