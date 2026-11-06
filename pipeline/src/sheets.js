'use strict';

// ----------------------------------------------------------------------------
// Write a note to the Google Sheets tab configured for notes (step 2).
//
// Find the row by customer ID in column A and write to the first empty cell
// from column X (index 23) onward; each cell in the row from X is a
// "Poznámka o průběhu řešení" column.
//
// Run the pipeline at the very end, after communication with the customer is
// complete. If the customer is missing from this sheet, treat it as a data
// error and stop with a clear message instead of silently adding a row or continuing.
// ----------------------------------------------------------------------------

const { google } = require('googleapis');
const { config } = require('./config');

let sheetsClientPromise = null;

function getSheetsClient() {
  if (!sheetsClientPromise) {
    const auth = new google.auth.GoogleAuth({
      keyFile: config.GOOGLE_CREDENTIALS_PATH,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    sheetsClientPromise = auth.getClient()
      .then((authClient) => google.sheets({ version: 'v4', auth: authClient }));
  }
  return sheetsClientPromise;
}

// Convert a zero-based column index to a letter (0 -> A, 23 -> X, 26 -> AA, ...).
function colToLetter(index0) {
  let n = index0 + 1;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

async function resolveSheetTitle(sheets) {
  if (config.SHEETS_NOTES_TAB) {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: config.SHEET_ID,
      fields: 'sheets.properties',
    });
    const match = (meta.data.sheets || []).find(
      (s) => s.properties.title === config.SHEETS_NOTES_TAB,
    );
    if (!match) throw new Error(`Sheet tab "${config.SHEETS_NOTES_TAB}" was not found.`);
    return match.properties.title;
  }
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: config.SHEET_ID,
    fields: 'sheets.properties',
  });
  const match = (meta.data.sheets || []).find(
    (s) => String(s.properties.sheetId) === String(config.SHEET_GID),
  );
  if (!match) throw new Error(`List s gid=${config.SHEET_GID} v tabulce nenalezen.`);
  return match.properties.title;
}

async function writeScheduleNote({ customerId, note }) {
  const sheets = await getSheetsClient();
  const title = await resolveSheetTitle(sheets);

  const colA = await sheets.spreadsheets.values.get({
    spreadsheetId: config.SHEET_ID,
    range: `'${title}'!A:A`,
  });
  const rows = colA.data.values || [];
  const rowIndex0 = rows.findIndex((r) => String((r && r[0]) || '').trim() === String(customerId).trim());

  if (rowIndex0 === -1) {
    const err = new Error(
      `Klient ${customerId} nebyl nalezen ve sloupci A tabulky "${config.SHEETS_NOTES_TAB}". ` +
      'Pipeline se v tomto kroku zastavuje — pokud pipeline běží, komunikace by měla být ' +
      'uzavřená a klient by v tabulce měl existovat. Zkontrolujte prosím ID klienta a tabulku ručně.',
    );
    err.code = 'sheet_row_not_found';
    throw err;
  }
  const rowNumber1 = rowIndex0 + 1;

  const startLetter = colToLetter(config.SHEET_NOTE_START_COL);
  const rowRange = await sheets.spreadsheets.values.get({
    spreadsheetId: config.SHEET_ID,
    range: `'${title}'!${startLetter}${rowNumber1}:ZZ${rowNumber1}`,
  });
  const existing = (rowRange.data.values && rowRange.data.values[0]) || [];
  const firstEmptyOffset = existing.findIndex((cell) => String(cell || '').trim() === '');
  const targetOffset = firstEmptyOffset === -1 ? existing.length : firstEmptyOffset;
  const targetColIndex0 = config.SHEET_NOTE_START_COL + targetOffset;
  const targetLetter = colToLetter(targetColIndex0);
  const targetCell = `'${title}'!${targetLetter}${rowNumber1}`;

  await sheets.spreadsheets.values.update({
    spreadsheetId: config.SHEET_ID,
    range: targetCell,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[note]] },
  });

  return { row: rowNumber1, cell: `${targetLetter}${rowNumber1}` };
}

module.exports = { writeScheduleNote, resolveSheetTitle, colToLetter };
