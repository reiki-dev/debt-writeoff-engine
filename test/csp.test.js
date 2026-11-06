'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const supertest = require('supertest');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'writeoff-csp-'));
fs.copyFileSync(path.join(__dirname, '..', 'users.demo.json'), path.join(tempDir, 'users.json'));

process.env.MOCK_MODE = 'true';
process.env.JWT_SECRET = 'csp-tests-use-a-long-random-secret-value-1';
process.env.USERS_FILE = path.join(tempDir, 'users.json');
process.env.CRM_AUDIT_DIR = path.join(tempDir, 'audit');
const { app } = require('../server');

// Regression: helmet's default `script-src-attr 'none'` disabled all inline
// onclick handlers, so the UI rendered but no button worked. Plain HTTP tests
// cannot see that, so assert the header and that the page still relies on handlers.
test('CSP allows inline event handlers that the UI depends on', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /onclick=/, 'UI uses inline handlers; if this fails the CSP rule below may be tightened');

  const response = await supertest(app).get('/');
  assert.equal(response.status, 200);
  const csp = response.headers['content-security-policy'] || '';
  assert.match(csp, /script-src-attr[^;]*'unsafe-inline'/);
  assert.doesNotMatch(csp, /script-src-attr 'none'/);
});
