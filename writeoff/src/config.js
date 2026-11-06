'use strict';

// ----------------------------------------------------------------------------
// Configuration comes only from the environment. Never hard-code the key.
// ----------------------------------------------------------------------------

function envInt(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`${name}: expected an integer, received ${JSON.stringify(v)}`);
  return n;
}

function envBool(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  if (/^(1|true|yes|on)$/i.test(v)) return true;
  if (/^(0|false|no|off)$/i.test(v)) return false;
  throw new Error(`${name}: expected true/false, received ${JSON.stringify(v)}`);
}

function envEnum(name, allowed, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  if (!allowed.includes(v)) {
    throw new Error(`${name}: allowed values are ${allowed.join('|')}, received ${JSON.stringify(v)}`);
  }
  return v;
}

const config = {
  BASE_URL: (process.env.CRM_BASE_URL || 'https://api.example.test').replace(/\/+$/, ''),
  API_KEY: process.env.CRM_API_KEY || '',

  // The postWriteoff() specification asks for the key in the x-api-key header
  // ("for better security"), but also accepts the apiKey query parameter.
  AUTH_MODE: envEnum('CRM_AUTH_MODE', ['header', 'query'], 'header'),

  // Balance export with loan buckets (l_*, r_*).
  EXPORT_ID: envInt('CRM_EXPORT_ID', 103),

  // Credit field name in export filters. The export returns the `id` column,
  // but filtering uses the table-qualified name.
  FILTER_CREDIT_FIELD: process.env.CRM_FILTER_CREDIT_FIELD || 'credits.id',
  FILTER_CUSTOMER_FIELD: process.env.CRM_FILTER_CUSTOMER_FIELD || 'customers.customer_id',

  // How to send write-off parameters. The specification table does not
  // distinguish query from body; JSON body is the configured default. This
  // remains configurable if the other transport is required.
  WRITEOFF_TRANSPORT: envEnum('CRM_WRITEOFF_TRANSPORT', ['body', 'query'], 'body'),

  // Operator performing the operation; included in write-off notes and audit log.
  ACTOR: process.env.CRM_ACTOR || '',

  // Allowed difference between bucket sum and system debt, in haléře.
  // Default is 0: any difference blocks the operation because it means the
  // column map does not represent the full debt.
  DEBT_TOLERANCE_MINOR: envInt('CRM_DEBT_TOLERANCE', 0),

  AUDIT_DIR: process.env.CRM_AUDIT_DIR || './audit',

  // Block repeated write-offs (already_applied / dangling_intent).
  // Disabled by default intentionally:
  //
  //   * CRM rejects a repeated write-off when its components are already paid,
  //     returning invalidAmount; the upstream system is authoritative here.
  //   * The idempotency key uses debt and allocation, so it changes after a
  //     successful write-off. It can match again if the credit returns to its
  //     prior state, as may happen in tests.
  //
  // The audit log is written regardless of this flag; disabling the block does
  // not affect the record of what happened.
  IDEMPOTENCY_GUARD: envBool('CRM_IDEMPOTENCY_GUARD', false),

  HTTP_TIMEOUT_MS: envInt('CRM_HTTP_TIMEOUT_MS', 30000),
  API_LAN: process.env.CRM_API_LAN || '',
};

function assertUsable(cfg = config) {
  if (!cfg.API_KEY) {
    throw new Error('CRM_API_KEY is not set — configure the environment variable');
  }
  return cfg;
}

module.exports = { config, assertUsable };
