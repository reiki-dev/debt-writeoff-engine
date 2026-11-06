'use strict';

// ----------------------------------------------------------------------------
// Export row -> Balance object: bucket balances in haléře plus the data needed
// by guards. This is a pure function with no network access.
// ----------------------------------------------------------------------------

const { pick, hasColumn, ExportError } = require('./exportReader');
const { toMinorOrZero, sumMinor } = require('./money');
const {
  ORDER, SOURCE_COLUMN, DEBT_COLUMN, OUT_OF_WATERFALL_COLUMNS,
  DIAGNOSTIC_COLUMNS, META_COLUMNS,
} = require('./buckets');

function buildBalance(row) {
  if (!row || typeof row !== 'object') throw new ExportError('buildBalance: row is not an object');

  if (!hasColumn(row, DEBT_COLUMN)) {
    throw new ExportError(
      `export is missing column "${DEBT_COLUMN}" — cannot reconcile the write-off without system debt`,
    );
  }

  const buckets = {};
  const missingColumns = [];

  for (const bucket of ORDER) {
    const column = SOURCE_COLUMN[bucket];
    if (!hasColumn(row, column)) {
      // Missing column means the bucket is unavailable. Treat it as zero, but
      // keep track of it so a debt mismatch can explain the reason.
      missingColumns.push({ bucket, column });
      buckets[bucket] = 0;
      continue;
    }
    buckets[bucket] = toMinorOrZero(pick(row, column), column);
  }

  // Balances outside the waterfall are kept to explain discrepancies.
  const outOfWaterfall = {};
  for (const column of OUT_OF_WATERFALL_COLUMNS) {
    if (!hasColumn(row, column)) continue;
    const value = toMinorOrZero(pick(row, column), column);
    if (value !== 0) outOfWaterfall[column] = value;
  }

  // Reference columns: both the raw value and the parsed value, if possible.
  const diagnostics = {};
  for (const column of DIAGNOSTIC_COLUMNS) {
    if (!hasColumn(row, column)) continue;
    const raw = pick(row, column);
    let minor = null;
    try {
      minor = toMinorOrZero(raw, column);
    } catch {
      minor = null;                     // Not numeric; display it as-is.
    }
    diagnostics[column] = { raw, minor };
  }

  const meta = {};
  for (const column of META_COLUMNS) {
    if (hasColumn(row, column)) meta[column] = pick(row, column);
  }

  return {
    customerId: String(pick(row, 'customer_id') ?? ''),
    creditId: String(pick(row, 'id') ?? ''),
    debt: toMinorOrZero(pick(row, DEBT_COLUMN), DEBT_COLUMN),
    buckets,
    bucketSum: sumMinor(ORDER.map((b) => buckets[b])),
    missingColumns,
    outOfWaterfall,
    diagnostics,
    meta,
    // Do not put the raw row in the audit log (it contains customer PII),
    // but keep it available to the caller for probe.
    raw: row,
  };
}

// Select the requested credit from the export response.
// Do not trust the filter: check the id column ourselves. If the credits.id
// filter did not work, failing is safer than writing off the wrong credit.
function selectCreditRow(rows, creditId) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new ExportError('export returned no rows — check customerId/creditId');
  }

  const wanted = String(creditId);
  const matches = rows.filter((row) => String(pick(row, 'id') ?? '') === wanted);

  if (matches.length === 0) {
    const seen = rows.map((row) => String(pick(row, 'id') ?? '?')).join(', ');
    throw new ExportError(
      `credit ${wanted} was not found for this customer. Credits in export: ${seen}`,
      { wanted, available: rows.map((row) => String(pick(row, 'id') ?? '?')) },
    );
  }
  if (matches.length > 1) {
    throw new ExportError(
      `export returned ${matches.length} rows for credit ${wanted} — expected one`,
      { wanted, count: matches.length },
    );
  }
  return matches[0];
}

// List the customer's credits with nonzero debt so the operator can choose creditId.
function listDebtors(rows) {
  return rows
    .map((row) => ({
      creditId: String(pick(row, 'id') ?? ''),
      debt: toMinorOrZero(pick(row, DEBT_COLUMN), DEBT_COLUMN),
    }))
    .filter((entry) => entry.debt > 0);
}

module.exports = { buildBalance, selectCreditRow, listDebtors };
