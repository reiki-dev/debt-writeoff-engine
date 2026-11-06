'use strict';

// ----------------------------------------------------------------------------
// Konfigurace modulu "Splátkový kalendář" (pipeline).
//
// CRM API klíč a doménu NEDUPLIKUJEME — bereme je z už nakonfigurovaného
// modulu odpisu (writeoff/src/config.js), stejně jako to dělá
// writeoff-bridge.js pro server.js. Nový klíč jen tehdy, když pipeline
// potřebuje něco, co odpis nepotřebuje (Playwright login, Google Sheets).
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
  // Sdilene s modulem odpisu.
  BASE_URL: writeoffConfig.BASE_URL,
  API_KEY: writeoffConfig.API_KEY,
  AUTH_MODE: writeoffConfig.AUTH_MODE,
  HTTP_TIMEOUT_MS: writeoffConfig.HTTP_TIMEOUT_MS,

  // Login do webove administrace CRM — API klic tam neplati,
  // formular kalendare zije za beznou session prohlizece. Krok 7 (Playwright).
  ADMIN_USER: process.env.CRM_ADMIN_USER || '',
  ADMIN_PASS: process.env.CRM_ADMIN_PASS || '',
  ADMIN_PATH: process.env.CRM_ADMIN_PATH || '/admin',
  SCHEDULE_FORM_PATH: process.env.CRM_SCHEDULE_FORM_PATH || '/admin/refund-schedule/create',

  // Kategorie (kroky 3-4). Vychozi hodnoty odpovidaji tomu, co uz je
  // example defaults for categories used by the pipeline.
  CATEGORY_CUSTOMER: envInt('CRM_PIPELINE_CUSTOMER_CATEGORY', 1),
  CATEGORY_CREDIT: envInt('CRM_PIPELINE_CREDIT_CATEGORY', 2),

  // Duvody blacklistu — vybira operator na zacatku (spolu s ID klienta),
  // ne uprostred pipeline.
  BLACKLIST_REASONS: {
    1: 'EPR',
    2: 'Client',
    3: 'Financial Arbitrator',
    4: 'Attorney',
    5: 'Attorney and Financial Arbitrator',
  },
  // Fixni text poznamky pro blacklist (krok 9) — podle zadani vzdy stejny.
  BLACKLIST_NOTE: 'Splátkový kalendář',

  // Google Sheets (krok 2).
  SHEET_ID: process.env.CRM_SHEET_ID || '',
  SHEET_GID: process.env.CRM_SHEET_GID || '',
  SHEETS_NOTES_TAB: process.env.SHEETS_NOTES_TAB || 'Notes',
  GOOGLE_CREDENTIALS_PATH: process.env.GOOGLE_APPLICATION_CREDENTIALS || '',
  // Sloupec A = ID klienta. Poznamka jde do prvni prazdne bunky od tohoto
  // sloupce doprava. Index 0-based, 23 = sloupec "X" (presne jak v zadani).
  SHEET_NOTE_START_COL: envInt('CRM_SHEET_NOTE_START_COL', 23),

  ACTOR: process.env.CRM_ACTOR || '',
  NOTE_TZ: process.env.NOTE_TIMEZONE || 'Europe/Prague',

  CALENDAR_TIMEOUT_MS: envInt('CRM_CALENDAR_TIMEOUT_MS', 60000),
};

// Volitelna kontrola pred spustenim pipeline — ukazuje operatorovi/adminovi
// srozumitelnou chybu misto tajemneho selhani uprostred kroku 2 nebo 7.
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
