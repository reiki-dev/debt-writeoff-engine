'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const mockCrm = require('../mock-crm');
const esc = require('../public/esc');

test('isMockMode only accepts explicit truthy values, case-insensitively', () => {
  const oldMode = process.env.MOCK_MODE;
  const oldApiKey = process.env.API_KEY;
  try {
    for (const value of ['1', 'true', 'TRUE', 'Yes', ' yes ']) {
      process.env.MOCK_MODE = value;
      process.env.API_KEY = '';
      assert.equal(mockCrm.isMockMode(), true, value);
    }
    for (const value of ['', '0', 'false', 'no', 'on', 'random']) {
      process.env.MOCK_MODE = value;
      process.env.API_KEY = 'your_placeholder_key';
      assert.equal(mockCrm.isMockMode(), false, value);
    }
    delete process.env.MOCK_MODE;
    delete process.env.API_KEY;
    assert.equal(mockCrm.isMockMode(), false);
  } finally {
    if (oldMode === undefined) delete process.env.MOCK_MODE;
    else process.env.MOCK_MODE = oldMode;
    if (oldApiKey === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = oldApiKey;
  }
});

test('server refuses missing, short, and placeholder JWT secrets', () => {
  for (const secret of ['', 'short', 'replace_with_a_secure_random_32_byte_hex_string', 'demo-secret-key-that-is-long-enough']) {
    const child = spawnSync(process.execPath, ['server.js'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, JWT_SECRET: secret, MOCK_MODE: 'true', API_KEY: '' },
      timeout: 10000,
    });
    assert.equal(child.status, 1, `JWT_SECRET=${JSON.stringify(secret)} stderr: ${child.stderr}`);
    assert.match(child.stderr, /JWT_SECRET must be at least 32 characters/i);
  }
});

test('esc encodes all HTML-sensitive characters', () => {
  assert.equal(esc(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  assert.equal(esc(null), '');
  assert.equal(esc(42), '42');
});

test('check-bom reports a BOM in a supplied temporary source file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bom-check-'));
  const file = path.join(dir, 'sample.js');
  try {
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('const ok = true;\n')]));
    const child = spawnSync(process.execPath, ['scripts/check-bom.js', file], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(child.status, 1);
    assert.match(child.stderr, /UTF-8 BOM found/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
