'use strict';

// ----------------------------------------------------------------------------
// Fill the "Splátkový kalendář" form in the admin UI using Playwright.
//
// Headless flow with a screenshot instead of leaving a browser open for manual submission:
//
//   1. fillCalendarForm()   — sign in headlessly, fill the form, and return a
//      screenshot for the orchestrator to save and show for review at
//      GET /calendar-preview.png. Keep the browser and page open per operationId.
//   2. confirmCalendarForm() — after the operator confirms the screenshot,
//      click Submit in the same open session and close the browser.
//   3. cancelCalendarForm()  — close the session without submitting, e.g. on
//      error or operation cancellation.
//
// UNVERIFIED: selector for the "Zapsat" button (input[type=submit][value*=Zapsat])
// This is inferred from the same pattern as the login button ("Přihlásit").
// Verify the exact selector during an actual run.
// ----------------------------------------------------------------------------

const { config } = require('./config');

const BASE = config.BASE_URL || 'https://api.example.test';
const LOGIN_URL = `${BASE}${config.ADMIN_PATH}`;
const CREATE_URL = `${BASE}${config.SCHEDULE_FORM_PATH}`;

function fmtDate(dateStr) { return `${dateStr} 23:59:00`; }

// operationId -> { browser, page }
const sessions = new Map();

// Crop the screenshot to one customer's form, excluding unrelated rows below it.
//
// 1. Try an element screenshot of the form row/block: the closest shared
//    ancestor of input[name="credit_id"] and input[name="customer_id"] is
//    typically a <tr> or <table> around one record. It adapts to content height,
//    so it works for schedules of different lengths. A manually calculated
//    bounding box may omit buttons or adjacent columns.
// 2. Fallback: union the bounding boxes of filled fields if the shared ancestor
//    is missing or too large (for example, the whole page).
// 3. Fallback: capture the whole page rather than fail without an image.
async function screenshotFormArea(page, lastRowIndex) {
  try {
    const rowShot = await screenshotHighlightedRow(page);
    if (rowShot) return rowShot;
  } catch {
    // Continue to the next fallback.
  }
  return screenshotFieldBoundingBox(page, lastRowIndex);
}

// Find the nearest common ancestor of the credit_id and customer_id fields
// (typically the highlighted form row/block) and return its element screenshot.
// Return null if no suitable element is found, such as when the shared ancestor
// is the whole <body>/<html> and would not crop anything.
async function screenshotHighlightedRow(page) {
  const handle = await page.evaluateHandle(() => {
    const a = document.querySelector('input[name="credit_id"]');
    const b = document.querySelector('input[name="customer_id"]');
    if (!a || !b) return null;

    function ancestors(el) {
      const list = [];
      for (let n = el; n; n = n.parentElement) list.push(n);
      return list;
    }
    const aAncestors = ancestors(a);
    const bAncestorSet = new Set(ancestors(b));
    let common = aAncestors.find((n) => bAncestorSet.has(n));
    if (!common) return null;

    // If the shared ancestor is a TR, try its parent TABLE only
    // Only when TR itself has no meaningful height (0); otherwise keep it.
    // when the TR itself has no meaningful height; otherwise use the single form row.
    // If the common ancestor is too high in the tree (BODY/HTML/the entire
    // main content), the fields are not in one continuous block; use fallback.
    const tag = common.tagName;
    if (tag === 'BODY' || tag === 'HTML') return null;
    const rect = common.getBoundingClientRect();
    if (!rect || rect.width < 10 || rect.height < 10) return null;
    // Sanity check: if the crop is nearly the whole page (>90% of viewport height),
    // the shared ancestor probably wraps all content instead of just the row.
    // form; prefer the bounding-box fallback instead.
    if (rect.height > window.innerHeight * 0.9) return null;
    return common;
  });

  const el = handle.asElement();
  if (!el) {
    await handle.dispose();
    return null;
  }
  try {
    return await el.screenshot();
  } finally {
    await handle.dispose();
  }
}

// Fallback approach: union the bounding boxes of the fields filled here
// (credit_id/customer_id, last schedule row, and note), with a small padding.
// Used only if the element screenshot above fails; see screenshotFormArea.
async function screenshotFieldBoundingBox(page, lastRowIndex) {
  const selectors = [
    'input[name="credit_id"]',
    'input[name="customer_id"]',
    'input[name="schedule_created"]',
    `input[name="refund_date${lastRowIndex}"]`,
    `input[name="refund_amount${lastRowIndex}"]`,
    'textarea[name="schedule_notes"]',
  ];

  try {
    const boxes = [];
    for (const sel of selectors) {
      const box = await page.locator(sel).boundingBox().catch(() => null);
      if (box) boxes.push(box);
    }
    if (!boxes.length) return page.screenshot();

    const pad = 24;
    const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad);
    const y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad);
    const right = Math.max(...boxes.map((b) => b.x + b.width)) + pad;
    const bottom = Math.max(...boxes.map((b) => b.y + b.height)) + pad;

    return await page.screenshot({ clip: { x, y, width: right - x, height: bottom - y } });
  } catch {
    return page.screenshot();
  }
}

async function fillCalendarForm(operationId, { customerId, creditId, startDate, schedule, note }) {
  // Lazy require: Playwright/Chromium may not be needed or installed in every
  // environment that uses pipeline/src, such as schedule.js tests.
  const { chromium } = require('playwright');

  if (sessions.has(operationId)) {
    await closeCalendarSession(operationId);
  }

  const browser = await chromium.launch({ headless: true, timeout: config.CALENDAR_TIMEOUT_MS });
  const page = await browser.newPage();
  sessions.set(operationId, { browser, page });

  try {
    if (!config.ADMIN_USER || !config.ADMIN_PASS) {
      throw new Error(
        'CRM_ADMIN_USER nebo CRM_ADMIN_PASS není v .env nastaveno — ' +
        'Playwright se nemá jak přihlásit do admin UI.',
      );
    }

    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
    await page.fill('input[name="name"]', config.ADMIN_USER);
    await page.fill('input[name="passw"]', config.ADMIN_PASS);
    await page.click('input[type="submit"][value*="Přihlásit"]');
    await page.waitForLoadState('networkidle');

    // Check that login succeeded; otherwise CRM returns the same login page for
    // every protected URL (including CREATE_URL), causing a confusing timeout
    // later at the credit_id field.
    //
    // Check visibility of the "passw" field, not just DOM presence. Authenticated
    // CRM pages may contain a hidden field with the same name (e.g. a password
    // change modal), so .count() can give a false positive after login.
    const stillOnLogin = await page.locator('input[name="passw"]').first()
      .isVisible().catch(() => false);
    if (stillOnLogin) {
      throw new Error(
        'Po pokusu o přihlášení je stále zobrazen přihlašovací formulář — ' +
        'zkontrolujte CRM_ADMIN_USER a CRM_ADMIN_PASS v .env.',
      );
    }

    await page.goto(CREATE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(1000);

    await page.fill('input[name="credit_id"]', String(creditId));
    await page.fill('input[name="customer_id"]', String(customerId));
    await page.fill('input[name="schedule_created"]', fmtDate(startDate));

    await page.fill('input[name="numberMonths"]', String(schedule.months));
    await page.click('input[name="autoFillFields"]');
    await page.waitForTimeout(2000);

    for (const row of schedule.rows) {
      const i = row.n - 1;
      await page.fill(`input[name="refund_date${i}"]`, fmtDate(row.date));
      await page.fill(`input[name="refund_amount${i}"]`, String(row.amount));
    }

    if (note) {
      await page.fill('textarea[name="schedule_notes"]', note);
    }

    // Crop the screenshot to the row/block containing this form; the whole
    // A full-page screenshot also shows other customers' existing schedules
    // below the form. Calculate the bounding box from the first and last fields
    // filled; this works regardless of the table structure.
    const screenshot = await screenshotFormArea(page, schedule.rows.length - 1);
    return { screenshot };
  } catch (err) {
    // On error, save a screenshot and current URL so the operator can tell which
    // page Playwright reached (login failure, redirect, changed form, etc.) rather
    // than seeing only "Timeout... waiting for locator(...)".
    try {
      err.debugScreenshot = await page.screenshot({ fullPage: true });
      err.debugUrl = page.url();
      err.message = `${err.message} [aktualni URL: ${err.debugUrl}]`;
    } catch {
      // The page may no longer be usable (e.g. a closed context). Preserve the
      // original error and omit only the screenshot.
    }
    await closeCalendarSession(operationId);
    throw err;
  }
}

async function confirmCalendarForm(operationId) {
  const session = sessions.get(operationId);
  if (!session) {
    throw new Error(
      'Relace prohlížeče pro tuto operaci už neexistuje (server restartoval nebo relace vypršela) — ' +
      'krok formuláře kalendáře je potřeba spustit znovu.',
    );
  }
  const { page } = session;
  try {
    // UNVERIFIED; see the note at the top of this file.
    await page.click('input[type="submit"][value*="Zapsat"]');
    await page.waitForLoadState('networkidle').catch(() => {});
  } finally {
    await closeCalendarSession(operationId);
  }
}

async function cancelCalendarForm(operationId) {
  await closeCalendarSession(operationId);
}

async function closeCalendarSession(operationId) {
  const session = sessions.get(operationId);
  if (!session) return;
  sessions.delete(operationId);
  await session.browser.close().catch(() => {});
}

module.exports = { fillCalendarForm, confirmCalendarForm, cancelCalendarForm, closeCalendarSession };
