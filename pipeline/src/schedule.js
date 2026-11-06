'use strict';

const { toMinor, fromMinor } = require('../../writeoff/src/money');

// ----------------------------------------------------------------------------
// Jediny zdroj pravdy pro vypocet splatkoveho grafiku.
//
// Puvodne byl vypocet zdvojeny: starsi predchozi klient volala
// require('./schedule') (computeSchedule), ktery v repozitari fyzicky
// neexistuje, a puvodni uzivatelske rozhrani melo vlastni JS implementaci
// (calcSchedule()) primo v prohlizeci. Tady je jedna implementace a bezi na
// serveru — stejny princip jako u odpisu (server.js: "Planu z prohlizece
// duverovat nelze", plan se pocita znovu). Klient smi jen ukazat nahled.
// ----------------------------------------------------------------------------

function guard(code, message, data = {}) {
  return { code, message, data };
}

function daysInMonth(year, monthIndex0) {
  const month = monthIndex0 + 1;
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function currency(minor) { return Number(fromMinor(minor)); }

function pp(n) { return String(n).padStart(2, '0'); }

function addMonths(year, monthIndex0, day, offset) {
  const idx = monthIndex0 + offset;
  const y = year + Math.floor(idx / 12);
  const m = ((idx % 12) + 12) % 12;
  const d = Math.min(day, daysInMonth(y, m));
  return { year: y, monthIndex0: m, day: d };
}

function toIso(year, monthIndex0, day) {
  return `${year}-${pp(monthIndex0 + 1)}-${pp(day)}`;
}

function toCzech(year, monthIndex0, day) {
  return `${pp(day)}.${pp(monthIndex0 + 1)}.${year}`;
}

// Vstup: startDate 'YYYY-MM-DD', total (Kc), a bud perPayment, nebo months.
// Vystup: { ok, guards, months, perPayment, lastAmount, total, startDate,
//           endDate, fmtStart, fmtEnd, rows: [{n, date, amount}] }
function computeSchedule({ startDate, total, perPayment, months } = {}) {
  const guards = [];

  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(startDate || ''));
  if (!m) {
    guards.push(guard('start_date_invalid',
      `startDate musi byt ve tvaru YYYY-MM-DD, prislo ${JSON.stringify(startDate)}`));
  }

  const totalNum = Number(total);
  if (!Number.isFinite(totalNum) || totalNum <= 0) {
    guards.push(guard('total_invalid', `total musi byt kladne cislo, prislo ${JSON.stringify(total)}`));
  }

  let perPaymentNum;
  let monthsNum;
  const hasPerPayment = perPayment !== undefined && perPayment !== null && perPayment !== '';
  const hasMonths = months !== undefined && months !== null && months !== '';

  if (hasPerPayment) {
    perPaymentNum = Number(perPayment);
    if (!Number.isFinite(perPaymentNum) || perPaymentNum <= 0) {
      guards.push(guard('per_payment_invalid',
        `perPayment musi byt kladne cislo, prislo ${JSON.stringify(perPayment)}`));
    }
  } else if (hasMonths) {
    monthsNum = Number(months);
    if (!Number.isInteger(monthsNum) || monthsNum <= 0) {
      guards.push(guard('months_invalid', `months musi byt kladne cele cislo, prislo ${JSON.stringify(months)}`));
    }
  } else {
    guards.push(guard('missing_input', 'zadejte perPayment nebo months'));
  }

  if (guards.length) return { ok: false, guards };

  const [, yStr, moStr, dStr] = m;
  const year = Number(yStr);
  const monthIndex0 = Number(moStr) - 1;
  const day = Number(dStr);

  if (monthIndex0 < 0 || monthIndex0 > 11 || day < 1
      || day > daysInMonth(year, monthIndex0)) {
    return { ok: false, guards: [guard('start_date_invalid',
      `startDate musi byt platne kalendarni datum, prislo ${JSON.stringify(startDate)}`)] };
  }

  let totalMinor;
  let perPaymentMinor;
  // Currency inputs support the same two decimal places as money.js; reject
  // finer precision instead of silently rounding it in the schedule.
  try {
    totalMinor = toMinor(String(total), 'total');
  } catch (error) {
    return { ok: false, guards: [guard('amount_precision_invalid', error.message)] };
  }
  if (totalMinor <= 0) {
    return { ok: false, guards: [guard('total_invalid', 'total musi byt kladne cislo')] };
  }
  if (hasPerPayment) {
    try {
      perPaymentMinor = toMinor(String(perPayment), 'perPayment');
    } catch (error) {
      return { ok: false, guards: [guard('amount_precision_invalid', error.message)] };
    }
    if (perPaymentMinor <= 0) {
      return { ok: false, guards: [guard('per_payment_invalid', 'perPayment musi byt kladne cislo')] };
    }
  }

  if (monthsNum === undefined) {
    monthsNum = perPaymentMinor >= totalMinor ? 1 : Math.ceil(totalMinor / perPaymentMinor);
  }
  if (perPaymentMinor === undefined) {
    perPaymentMinor = Math.ceil(totalMinor / monthsNum);
  }
  perPaymentNum = currency(perPaymentMinor);

  const rows = [];
  let remaining = totalMinor;
  for (let i = 0; i < monthsNum; i += 1) {
    const isLast = i === monthsNum - 1;
    const amountMinor = isLast ? remaining : Math.min(remaining, perPaymentMinor);
    const { year: ry, monthIndex0: rm, day: rd } = addMonths(year, monthIndex0, day, i);
    rows.push({ n: i + 1, date: toIso(ry, rm, rd), amount: currency(amountMinor) });
    remaining -= amountMinor;
  }

  const last = rows[rows.length - 1];
  const [lastY, lastMo, lastD] = last.date.split('-').map(Number);

  return {
    ok: true,
    guards: [],
    months: monthsNum,
    perPayment: perPaymentNum,
    lastAmount: last.amount,
    total: currency(totalMinor),
    startDate: toIso(year, monthIndex0, day),
    endDate: last.date,
    fmtStart: toCzech(year, monthIndex0, day),
    fmtEnd: toCzech(lastY, lastMo - 1, lastD),
    rows,
  };
}

module.exports = { computeSchedule };
