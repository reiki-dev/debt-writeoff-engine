'use strict';

// ----------------------------------------------------------------------------
// Money handling. No floats in this module: all amounts are integer haléře (minor units).
//
// The reason is simple: 0.1 + 0.2 !== 0.3. We add and subtract balances across
// 16 buckets, then reconcile the total with system debt. A rounding error in
// the last decimal place can make a live write-off fail reconciliation.
//
// The CRM export returns amounts as strings ("12345.67"), and the write-off
// API expects Decimal values. Convert only at the boundaries: parse on input,
// format on output.
// ----------------------------------------------------------------------------

const SCALE = 2;                 // haléře
const FACTOR = 100;
const MAX_MINOR = Number.MAX_SAFE_INTEGER;

class MoneyError extends TypeError {}

// "12345.67" | "1 725,00" | 24000 -> 1234567 | 172500 | 2400000
function toMinor(value, field = 'value') {
  if (value === undefined || value === null) {
    throw new MoneyError(`${field}: empty value (${value})`);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new MoneyError(`${field}: not a number (${value})`);
    return toMinor(value.toFixed(SCALE), field);
  }

  // Spaces (including NBSP) are accepted as thousands separators; comma is a decimal separator.
  const raw = String(value).replace(/[\s ]/g, '').replace(',', '.');
  if (raw === '') throw new MoneyError(`${field}: empty string`);

  const m = /^([+-])?(\d+)(?:\.(\d*))?$/.exec(raw);
  if (!m) throw new MoneyError(`${field}: does not look like an amount: ${JSON.stringify(value)}`);

  const [, sign, intPart, fracPart = ''] = m;

  // Do not silently discard digits: "0.005" is either bad data or uses
  // unsupported precision; in either case, failing is safer than rounding.
  if (fracPart.length > SCALE && /[1-9]/.test(fracPart.slice(SCALE))) {
    throw new MoneyError(`${field}: precision beyond ${SCALE} decimal places is unsupported: ${value}`);
  }

  const frac = (fracPart + '0'.repeat(SCALE)).slice(0, SCALE);
  const minor = Number(intPart) * FACTOR + Number(frac);

  if (!Number.isSafeInteger(minor) || minor > MAX_MINOR) {
    throw new MoneyError(`${field}: amount is outside the safe range: ${value}`);
  }
  return sign === '-' ? -minor : minor;
}

// Same conversion, but treat empty/missing values as zero (for optional columns).
function toMinorOrZero(value, field = 'value') {
  if (value === undefined || value === null) return 0;
  const raw = String(value).replace(/[\s ]/g, '');
  if (raw === '') return 0;
  return toMinor(value, field);
}

// 1234567 -> "12345.67"  (format expected by Decimal in the API)
function fromMinor(minor) {
  if (!Number.isInteger(minor)) throw new MoneyError(`fromMinor: not an integer: ${minor}`);
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const int = Math.trunc(abs / FACTOR);
  const frac = String(abs % FACTOR).padStart(SCALE, '0');
  return `${sign}${int}.${frac}`;
}

function sumMinor(values) {
  let total = 0;
  for (const v of values) {
    if (!Number.isInteger(v)) throw new MoneyError(`sumMinor: not an integer: ${v}`);
    total += v;
  }
  if (!Number.isSafeInteger(total)) throw new MoneyError('sumMinor: overflow');
  return total;
}

module.exports = { SCALE, MoneyError, toMinor, toMinorOrZero, fromMinor, sumMinor };
