'use strict';

// Public module interface used by the web route.

const { config, assertUsable } = require('./config');
const buckets = require('./buckets');
const money = require('./money');
const { ApiError } = require('./client');
const {
  fetchExport, fetchCreditRows, normalize, pick, hasColumn, ExportError,
} = require('./exportReader');
const { buildBalance, selectCreditRow, listDebtors } = require('./balance');
const { allocate } = require('./waterfall');
const guards = require('./guards');
const { buildPlan, computePlan, buildPayload, idempotencyKey } = require('./plan');
const { applyPlan, postWriteoff, verify, WriteoffError, WRITEOFF_PATH } = require('./apply');
const audit = require('./audit');
const { formatPlan, formatApply, formatProbe } = require('./report');

module.exports = {
  // configuration
  config,
  assertUsable,

  // domain model
  buckets,
  money,

  // reading
  fetchExport,
  fetchCreditRows,
  normalize,
  pick,
  hasColumn,
  buildBalance,
  selectCreditRow,
  listDebtors,

  // calculation
  allocate,
  guards,
  buildPlan,
  computePlan,
  buildPayload,
  idempotencyKey,

  // write-off
  applyPlan,
  postWriteoff,
  verify,
  WRITEOFF_PATH,

  // audit and output
  audit,
  formatPlan,
  formatApply,
  formatProbe,

  // errors
  ApiError,
  ExportError,
  WriteoffError,
  MoneyError: money.MoneyError,
};
