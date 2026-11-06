'use strict';

// ----------------------------------------------------------------------------
// Configuration for the "Splátkový kalendář" (payment schedule) pipeline module.
//
// Do not duplicate the CRM API key or host; use the existing write-off module
// configuration (writeoff/src/config.js), as writeoff-bridge.js does for
// server.js. Add a key only if the pipeline needs something the write-off
// module does not (Playwright login or Google Sheets).
// ----------------------------------------------------------------------------

const { config: writeoffConfig } = require('../../writeoff/src/config');

function envInt(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`${name}: ocekavalo se cele cislo, prislo ${JSON.stringify(v)}`);
  return n;
}

const config = {
  // Shared with the write-off module.
  BASE_URL: writeoffConfig.BASE_URL,
  API_KEY: writeoffConfig.API_KEY,
  AUTH_MODE: writeoffConfig.AUTH_MODE,
  HTTP_TIMEOUT_MS: writeoffConfig.HTTP_TIMEOUT_MS,
  AUDIT_DIR: writeoffConfig.AUDIT_DIR,

  // Login for the CRM web admin; the API key is not used here. The calendar
  // form requires a regular browser session. Step 7 (Playwright).
  ADMIN_USER: process.env.CRM_ADMIN_USER || '',
  ADMIN_PASS: process.env.CRM_ADMIN_PASS || '',
  ADMIN_PATH: process.env.CRM_ADMIN_PATH || '/admin',
  SCHEDULE_FORM_PATH: process.env.CRM_SCHEDULE_FORM_PATH || '/admin/refund-schedule/create',

  // Categories (steps 3-4). Defaults match the configured pipeline values.
  // example defaults for categories used by the pipeline.
  CATEGORY_CUSTOMER: envInt('CRM_PIPELINE_CUSTOMER_CATEGORY', 1),
  CATEGORY_CREDIT: envInt('CRM_PIPELINE_CREDIT_CATEGORY', 2),

  // Blacklist reasons are selected by the operator at the start, alongside
  // the customer ID, rather than midway through the pipeline.
  BLACKLIST_REASONS: {
    1: 'EPR',
    2: 'Client',
    3: 'Financial Arbitrator',
    4: 'Attorney',
    5: 'Attorney and Financial Arbitrator',
  },
  // Fixed blacklist note (step 9), as required.
  BLACKLIST_NOTE: 'Splátkový kalendář',

  // Google Sheets (step 2).
  SHEET_ID: process.env.CRM_SHEET_ID || '',
  SHEET_GID: process.env.CRM_SHEET_GID || '',
  SHEETS_NOTES_TAB: process.env.SHEETS_NOTES_TAB || 'Notes',
  GOOGLE_CREDENTIALS_PATH: process.env.GOOGLE_APPLICATION_CREDENTIALS || '',
  // Column A contains the customer ID. Write the note to the first empty cell
  // from this column onward. Zero-based index; 23 is column "X".
  SHEET_NOTE_START_COL: envInt('CRM_SHEET_NOTE_START_COL', 23),

  ACTOR: process.env.CRM_ACTOR || '',
  NOTE_TZ: process.env.NOTE_TIMEZONE || 'Europe/Prague',

  CALENDAR_TIMEOUT_MS: envInt('CRM_CALENDAR_TIMEOUT_MS', 60000),
};

// Optional validation before starting the pipeline; show the operator/admin a
// clear error instead of an opaque failure midway through step 2 or 7.
function assertPipelineUsable(cfg = config) {
  const missing = [];
  if (!cfg.API_KEY) missing.push('CRM_API_KEY');
  if (!cfg.ADMIN_USER) missing.push('CRM_ADMIN_USER');
  if (!cfg.ADMIN_PASS) missing.push('CRM_ADMIN_PASS');
  if (!cfg.SHEET_ID) missing.push('CRM_SHEET_ID');
  if (!cfg.GOOGLE_CREDENTIALS_PATH) missing.push('GOOGLE_APPLICATION_CREDENTIALS');
  if (missing.length) {
    throw new Error(`Pipeline neni nakonfigurovana — chybi promenne: ${missing.join(', ')}`);
  }
  return cfg;
}

module.exports = { config, assertPipelineUsable };
