'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const supertest = require('supertest');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'writeoff-routes-'));
const usersFile = path.join(tempDir, 'users.json');
const auditDir = path.join(tempDir, 'audit');
fs.copyFileSync(path.join(__dirname, '..', 'users.demo.json'), usersFile);
const users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
for (const user of users) user.password = bcrypt.hashSync('route-test-password', 4);
users.push({ id: 'xss-test-user', username: '<img src=x onerror=1>', role: 'mail', password: bcrypt.hashSync('route-test-password', 4) });
fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));

process.env.MOCK_MODE = 'true';
process.env.JWT_SECRET = 'route-tests-use-a-long-random-secret-value';
process.env.USERS_FILE = usersFile;
process.env.CRM_AUDIT_DIR = auditDir;
process.env.CRM_IDEMPOTENCY_GUARD = 'false';
const { app } = require('../server');
const request = supertest(app);

const byRole = role => JSON.parse(fs.readFileSync(usersFile, 'utf8')).find(u => u.role === role);
async function tokenFor(user) {
  const response = await request.post('/auth/login').send({ username: user.username, password: 'route-test-password' });
  assert.equal(response.status, 200);
  return response.body.token;
}
const auth = token => ({ Authorization: `Bearer ${token}` });

test('login returns generic 401 for wrong password and unknown user; valid login returns token', async () => {
  const wrong = await request.post('/auth/login').send({ username: 'admin', password: 'wrong' });
  const unknown = await request.post('/auth/login').send({ username: 'unknown-user', password: 'wrong' });
  assert.equal(wrong.status, 401);
  assert.deepEqual(unknown.body, wrong.body);
  const valid = await request.post('/auth/login').send({ username: 'admin', password: 'route-test-password' });
  assert.equal(valid.status, 200);
  assert.equal(typeof valid.body.token, 'string');
});

test('protected routes reject absent and invalid bearer tokens', async () => {
  assert.equal((await request.get('/api/users')).status, 401);
  assert.equal((await request.get('/api/users').set(auth('invalid'))).status, 401);
});

test('RBAC enforces mail, cc and admin route access', async () => {
  const mail = await tokenFor(byRole('mail'));
  for (const url of ['/api/writeoff/credits/1001']) {
    assert.equal((await request.get(url).set(auth(mail))).status, 403, url);
  }
  const cc = await tokenFor(byRole('cc'));
  for (const url of ['/api/client/1001', '/api/users']) {
    assert.equal((await request.get(url).set(auth(cc))).status, 403, url);
  }
  const admin = await tokenFor(byRole('admin'));
  for (const [method, url] of [['get', '/api/client/1001'], ['get', '/api/users'], ['get', '/api/writeoff/credits/1001']]) {
    const response = await request[method](url).set(auth(admin));
    assert.notEqual(response.status, 403, url);
  }
});

test('current stored role takes effect immediately after a login', async () => {
  const adminUser = byRole('admin');
  const token = await tokenFor(adminUser);
  assert.equal((await request.get('/api/users').set(auth(token))).status, 200);
  const changed = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
  changed.find(u => u.id === adminUser.id).role = 'mail';
  fs.writeFileSync(usersFile, JSON.stringify(changed, null, 2));
  assert.equal((await request.get('/api/users').set(auth(token))).status, 403);
  changed.find(u => u.id === adminUser.id).role = 'admin';
  fs.writeFileSync(usersFile, JSON.stringify(changed, null, 2));
});

test('preview, stale-key rejection, and real apply path verify and audit in order', async () => {
  const token = await tokenFor(byRole('admin'));
  const input = { customerId: '1001', creditId: '2001', target: '2500' };
  const preview = await request.post('/api/writeoff/preview').set(auth(token)).send(input);
  assert.equal(preview.status, 200);
  const plan = preview.body;
  assert.ok(plan.idempotencyKey);
  assert.equal(plan.debtBefore.minor - plan.target.minor, plan.amount.minor);
  assert.equal(plan.rows.reduce((sum, row) => sum + (row.take?.minor || 0), 0), plan.amount.minor);
  const stale = await request.post('/api/writeoff/apply').set(auth(token)).send({ ...input, idempotencyKey: 'stale-key' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'plan_changed');
  const applied = await request.post('/api/writeoff/apply').set(auth(token)).send({ ...input, idempotencyKey: plan.idempotencyKey });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.status, 'applied');
  assert.equal(applied.body.verification.ok, true);
  const auditFile = path.join(auditDir, 'writeoff.jsonl');
  assert.equal(fs.existsSync(auditFile), true);
  const events = fs.readFileSync(auditFile, 'utf8').trim().split('\n').map(line => JSON.parse(line).event);
  assert.deepEqual(events, ['intent', 'applied', 'verified']);
});

test('blocking guards return 409 blocked and users cannot demote the last admin', async () => {
  const token = await tokenFor(byRole('admin'));
  const preview = await request.post('/api/writeoff/preview').set(auth(token)).send({ customerId: '1001', creditId: '2001', target: '999999' });
  assert.equal(preview.status, 200);
  const blocked = await request.post('/api/writeoff/apply').set(auth(token)).send({ customerId: '1001', creditId: '2001', target: '999999', idempotencyKey: preview.body.idempotencyKey });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'blocked');
  const admin = byRole('admin');
  const demote = await request.patch(`/api/users/${admin.id}/role`).set(auth(token)).send({ role: 'cc' });
  assert.equal(demote.status, 409);
});

test('debug is hidden in mock mode; XSS is returned as JSON text for UI escaping', async () => {
  const token = await tokenFor(byRole('admin'));
  assert.equal((await request.get('/debug/1001').set(auth(token))).status, 404);
  assert.equal((await request.get('/debug/not-numeric').set(auth(token))).status, 404);
  const users = await request.get('/api/users').set(auth(token));
  assert.equal(users.status, 200);
  assert.match(users.headers['content-type'], /application\/json/);
  assert.ok(users.body.users.some(user => user.username === '<img src=x onerror=1>'));
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'public', 'esc.js'), 'utf8'), /&lt;/);
});

test('overview aggregates decimal payment rows exactly and keeps numeric Kč fields', async () => {
  const admin = byRole('admin');
  const token = jwt.sign({ id: admin.id, username: admin.username, role: 'admin' }, process.env.JWT_SECRET);
  const originalMode = process.env.MOCK_MODE;
  const originalGet = axios.get;
  const loan = {
    id_0: '500', typ_produktu: 'Test', credit_status: 'Active', customer_id_3: '1001',
    amount_7: '1.00', debt_16: '0.30',
  };
  const payment = { credit_id_1: '500', amount_4: '0.10' };
  process.env.MOCK_MODE = 'false';
  axios.get = async (_url, { params }) => ({
    data: { data: params.id === 101 ? [loan] : [payment, payment, payment] },
  });

  try {
    const response = await request.get('/api/client/1001').set(auth(token));
    assert.equal(response.status, 200);
    assert.equal(response.body.loans[0].platba, 0.3);
    assert.equal(response.body.loans[0].uhrJist, 0.3);
    assert.equal(typeof response.body.loans[0].platba, 'number');
    assert.equal(response.body.totalJistina, 1);
  } finally {
    axios.get = originalGet;
    if (originalMode === undefined) delete process.env.MOCK_MODE;
    else process.env.MOCK_MODE = originalMode;
  }
});

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
