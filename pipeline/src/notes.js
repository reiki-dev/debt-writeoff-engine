'use strict';

// ----------------------------------------------------------------------------
// Pipeline notes. Two different texts are used for different steps:
//
//  - buildScheduleNote(): long text with a timestamp, used in Google
//    Sheets (step 2), customer and loan notes (step 10), and the calendar form
//    (schedule_notes, steps 7-8). Example:
//      "YYYY-MM-DD HH:mm - anonymized payment-plan note"
//
//  - writeoffNote(): short text containing only "DoN" or "EPR" for write-off
//    (step 6), kept separate from the longer note.
// ----------------------------------------------------------------------------

const { config } = require('./config');

const stampFmt = new Intl.DateTimeFormat('sv-SE', {
  timeZone: config.NOTE_TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit',
});

function noteStamp(date = new Date()) {
  return stampFmt.format(date).replace(',', '');
}

function assertType(type) {
  if (type !== 'DON' && type !== 'EPR') {
    throw new Error(`neznamy typ dohody ${JSON.stringify(type)}, ocekavano DON|EPR`);
  }
}

function buildScheduleNote({ type, schedule, date = new Date() }) {
  assertType(type);
  const label = type === 'DON' ? 'mám DoN' : 'EPR';
  return `${noteStamp(date)} - ${label}, Klient platí ${schedule.total} po ${schedule.perPayment}`
    + ` od ${schedule.fmtStart} do ${schedule.fmtEnd}`;
}

function writeoffNote(type) {
  assertType(type);
  return type === 'DON' ? 'DoN' : 'EPR';
}

module.exports = { buildScheduleNote, writeoffNote, noteStamp };
