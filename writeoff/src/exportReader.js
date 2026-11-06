'use strict';

// ----------------------------------------------------------------------------
// Read export/export and convert the response to rows so columns can be
// retrieved safely BY NAME.
//
// Why this is a separate file with guards instead of a few inline lines:
//
// export/export supports two formats with fundamentally different risks.
//   * format=assoc  -> data.data = [ { "l_amount_93": "12345.67", ... } ]
//                      keys include the column index as a suffix
//   * without format -> data.data = [ [ "2001", "1001", ... ] ]
//                      flat arrays; mapping depends ONLY on the order of keys
//                      in data.names
//
// The second format is risky for a module that moves money: an offset of one
// element can silently produce a wrong total in a plausible-looking report.
// Positional mode is supported, but row length must match the number of names;
// any mismatch throws instead of reading only the available values.
//
// The module requests assoc by default.
// ----------------------------------------------------------------------------

const { call } = require('./client');
const { config } = require('./config');

class ExportError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ExportError';
    Object.assign(this, details);
  }
}

// A column may be named exactly `debt` or `debt_21` (its export index).
// Try an exact match first, then a pattern, and detect ambiguous matches.
function resolveKey(row, column) {
  if (Object.prototype.hasOwnProperty.call(row, column)) return column;

  const re = new RegExp(`^${column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(_\\d+)?$`);
  const hits = Object.keys(row).filter((k) => re.test(k));

  if (hits.length === 0) return undefined;
  if (hits.length > 1) {
    throw new ExportError(
      `column "${column}" resolves ambiguously: ${hits.join(', ')} — ` +
      `specify its name in src/buckets.js`,
      { column, candidates: hits },
    );
  }
  return hits[0];
}

// Get a column value. undefined means the column is missing from the export
// (unlike "" or "0.00", which are returned as-is).
function pick(row, column) {
  const key = resolveKey(row, column);
  return key === undefined ? undefined : row[key];
}

function hasColumn(row, column) {
  return resolveKey(row, column) !== undefined;
}

// Convert either format to an array of objects.
function normalize(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new ExportError('response has no data', { payload });
  }
  const { names, data } = payload;
  if (!names || typeof names !== 'object') {
    throw new ExportError('response has no data.names', { keys: Object.keys(payload) });
  }
  if (!Array.isArray(data)) {
    throw new ExportError('data.data is not an array', { got: typeof data });
  }
  if (data.length === 0) return [];

  // assoc: rows are already objects
  if (!Array.isArray(data[0])) {
    for (const [i, row] of data.entries()) {
      if (Array.isArray(row) || row === null || typeof row !== 'object') {
        throw new ExportError(`row ${i}: mixed formats in data.data`, { index: i });
      }
    }
    return data;
  }

  // Positional: zip values by names order, but only when lengths match exactly.
  const columns = Object.keys(names);
  return data.map((row, i) => {
    if (!Array.isArray(row)) {
      throw new ExportError(`row ${i}: mixed formats in data.data`, { index: i });
    }
    if (row.length !== columns.length) {
      throw new ExportError(
        `row ${i}: ${row.length} values but ${columns.length} names in data.names — ` +
        `positional mapping is unreliable; request format=assoc`,
        { index: i, values: row.length, names: columns.length },
      );
    }
    const obj = {};
    for (let c = 0; c < columns.length; c += 1) obj[columns[c]] = row[c];
    return obj;
  });
}

async function fetchExport({ id, filter, format = 'assoc', limit = 0, cfg = config, ...rest } = {}) {
  const envelope = await call('/api/v1.0/export/export', {
    query: { id, filter, format, limit },
    cfg,
    ...rest,
  });
  return { rows: normalize(envelope.data), names: envelope.data.names, envelope };
}

// Rows for one credit. creditId is optional; if omitted, return all of the
// customer's credits so the operator can choose one.
async function fetchCreditRows({ customerId, creditId, cfg = config, ...rest } = {}) {
  if (customerId === undefined || customerId === null || customerId === '') {
    throw new ExportError('customerId is required');
  }

  const filter = [
    {
      name: cfg.FILTER_CUSTOMER_FIELD,
      act: '=',
      value: String(customerId),
      operator: 'and',
    },
  ];
  if (creditId !== undefined && creditId !== null && creditId !== '') {
    filter.push({
      name: cfg.FILTER_CREDIT_FIELD,
      act: '=',
      value: String(creditId),
      operator: 'and',
    });
  }

  return fetchExport({ id: cfg.EXPORT_ID, filter, cfg, ...rest });
}

module.exports = { fetchExport, fetchCreditRows, normalize, pick, hasColumn, resolveKey, ExportError };
