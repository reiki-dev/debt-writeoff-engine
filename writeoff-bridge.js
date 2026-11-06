'use strict';

// ----------------------------------------------------------------------------
// Bridge between web server settings and the write-off module.
//
// The module reads the environment at require time (see writeoff/src/config.js),
// so variables must be set before loading it. Keeping this in a separate module
// makes the ordering explicit regardless of require order in server.js.
//
// No new secrets are introduced. The key and host come from existing site settings:
//   API_KEY      -> CRM_API_KEY
//   API_BASE_URL -> CRM_BASE_URL, but use only the origin: the site variable
//                   contains the full export/export path, and the module adds
//                   its own paths (/api/v1.0/export/export and
//                   /api/v1.0/special/writeoff). Passing the full URL would
//                   produce .../export/export/api/v1.0/special/writeoff.
//
// Do not duplicate the key in .env: rotation should require changing one variable.
// ----------------------------------------------------------------------------

const path = require('node:path');

// Load .env here as well. server.js does this first, but a utility script may
// require this bridge directly; without .env it could use empty settings and
// silently fall back to the default host without a key.
// Repeated calls are safe: dotenv does not overwrite existing environment values.
// server.js loads dotenv only when it is launched as the application entry point.

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

if (!process.env.CRM_API_KEY && process.env.API_KEY) {
  process.env.CRM_API_KEY = process.env.API_KEY;
}

if (!process.env.CRM_BASE_URL) {
  const derived = originOf(process.env.API_BASE_URL || '');
  if (derived) {
    // Upgrade the scheme to https; NEVER inherit http.
    //
    // Export reads may work over http, but write requests require https:
    // POST /api/v1.0/special/writeoff over http can return 500 MethodAccessDenied
    // and identify getWriteoff instead of postWriteoff, indicating the request
    // did not reach the intended handler. Use https for write-off requests.
    //
    // The API key must not be sent in clear text on a request that moves money.
    const secure = derived.replace(/^http:\/\//i, 'https://');
    if (secure !== derived) {
      console.warn(`[writeoff] API_BASE_URL uses http; using ${secure} for write-off requests`);
    }
    process.env.CRM_BASE_URL = secure;
  }
  // If no URL could be derived, the module has its own https default for the same host.
} else if (/^http:\/\//i.test(process.env.CRM_BASE_URL)) {
  console.warn('[writeoff] CRM_BASE_URL uses http; the CRM write method will likely reject the request'
    + ' (MethodAccessDenied)');
}

// Audit log. In the container this is /app/audit and it MUST be a volume:
// it stores idempotency data and unfinished attempts, which would otherwise be
// lost when the image is rebuilt. See docker-compose.yml.
if (!process.env.CRM_AUDIT_DIR) {
  process.env.CRM_AUDIT_DIR = path.join(__dirname, 'audit');
}

const writeoff = require('./writeoff');
const mockCrm = require('./mock-crm');

if (mockCrm.isMockMode()) {
  console.log('[writeoff] Mock mode enabled: using synthetic fixtures for debt write-off.');
  const { ORDER, SOURCE_COLUMN, PAYLOAD_FIELD } = writeoff.buckets;
  const { toMinor, fromMinor } = writeoff.money;
  const balances = new Map();

  async function mockFetch(url, init = {}) {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('/special/writeoff')) {
      const payload = init.body ? JSON.parse(init.body) : Object.fromEntries(new URL(url).searchParams);
      const id = `${payload.customerId}:${payload.creditId}`;
      const rows = mockCrm.getMockCreditRows({ customerId: payload.customerId, creditId: payload.creditId });
      const base = balances.get(id) || rows[0];
      const updated = { ...base };
      for (const bucket of ORDER) {
        const field = PAYLOAD_FIELD[bucket];
        if (payload[field] === undefined) continue;
        const column = SOURCE_COLUMN[bucket];
        updated[column] = fromMinor(toMinor(updated[column] || 0) - toMinor(payload[field]));
      }
      const newDebt = toMinor(updated.debt) - ORDER.reduce((sum, bucket) => {
        const field = PAYLOAD_FIELD[bucket];
        return sum + (payload[field] === undefined ? 0 : toMinor(payload[field]));
      }, 0);
      updated.debt = fromMinor(newDebt);
      balances.set(id, updated);
      return new Response(JSON.stringify({ status: 200, data: { status: 'success', writeoffId: `MOCK-${Date.now()}` } }));
    }
    const params = new URL(url).searchParams;
    const filters = JSON.parse(params.get('filter') || '[]');
    const customerId = filters.find((f) => f.name === 'customers.customer_id')?.value || '1001';
    const creditId = filters.find((f) => f.name === 'credits.id')?.value;
    const rows = mockCrm.getMockCreditRows({ customerId, creditId }).map((row) => {
      return balances.has(`${customerId}:${row.id}`) ? { ...balances.get(`${customerId}:${row.id}`) } : row;
    });
    return new Response(JSON.stringify({ status: 200, data: { names: {}, data: rows } }));
  }

  module.exports = {
    ...writeoff,
    fetchCreditRows: async ({ customerId, creditId }) => ({
      rows: mockCrm.getMockCreditRows({ customerId, creditId }).map((row) => {
        return balances.has(`${customerId}:${row.id}`) ? { ...balances.get(`${customerId}:${row.id}`) } : row;
      }),
    }),
    buildPlan: (options) => writeoff.buildPlan({ ...options, fetchImpl: mockFetch }),
    applyPlan: (plan, options) => writeoff.applyPlan(plan, { ...options, fetchImpl: mockFetch }),
  };
} else {
  module.exports = writeoff;
}

