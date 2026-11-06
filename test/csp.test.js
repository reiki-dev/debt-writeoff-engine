'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const supertest = require('supertest');

const root = path.join(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'writeoff-csp-'));
fs.copyFileSync(path.join(root, 'users.demo.json'), path.join(tempDir, 'users.json'));

process.env.MOCK_MODE = 'true';
process.env.JWT_SECRET = 'csp-tests-use-a-long-random-secret-value-1';
process.env.USERS_FILE = path.join(tempDir, 'users.json');
process.env.CRM_AUDIT_DIR = path.join(tempDir, 'audit');
const { app } = require('../server');

const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const clientJs = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');

function declaredActions(source) {
  return [...source.matchAll(/data-action\s*=\s*(["'])([^"']+)\1/g)].map(match => match[2]);
}

test('UI has no inline event attributes or inline scripts', () => {
  assert.doesNotMatch(html, /\bon[a-z]+\s*=/i, 'HTML must not contain inline event attributes');
  assert.doesNotMatch(clientJs, /\bon[a-z]+\s*=/i, 'client JS must not generate inline event attributes');
  assert.doesNotMatch(html, /<script\b(?![^>]*\bsrc\s*=)[^>]*>/i, 'HTML must not contain inline script blocks');
  assert.match(html, /<script\s+src="\/app\.js"\s+defer><\/script>/);
});

test('every declared data-action has a delegated ACTIONS handler', () => {
  const actionBlock = clientJs.match(/const ACTIONS\s*=\s*\{([\s\S]*?)\n\};/);
  assert.ok(actionBlock, 'ACTIONS object must exist');
  const handled = new Set([...actionBlock[1].matchAll(/(?:'([^']+)'|([A-Za-z_$][\w$-]*))\s*:/g)]
    .map(match => match[1] || match[2]));
  const declared = new Set([...declaredActions(html), ...declaredActions(clientJs)]);
  assert.ok(declared.size > 0, 'UI must declare delegated actions');
  assert.deepEqual([...declared].filter(action => !handled.has(action)), []);
});

test('CSP serves scripts without unsafe-inline', async () => {
  const response = await supertest(app).get('/');
  assert.equal(response.status, 200);
  const csp = response.headers['content-security-policy'] || '';
  const scriptSrc = csp.split(';').map(directive => directive.trim()).find(directive => directive.startsWith('script-src ')) || '';
  assert.match(scriptSrc, /'self'/);
  assert.match(scriptSrc, /cdnjs\.cloudflare\.com/);
  assert.doesNotMatch(scriptSrc, /unsafe-inline/i);
  assert.doesNotMatch(csp, /script-src-attr[^;]*unsafe-inline/i);
  assert.match(csp, /style-src[^;]*unsafe-inline/i);
});
