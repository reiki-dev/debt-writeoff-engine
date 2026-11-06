'use strict';

// ----------------------------------------------------------------------------
// Orchestrator for the "Splátkový kalendář" (payment schedule) pipeline, steps 1-10.
//
// Operation state is kept in process memory. The module is used by one operator
// at a time and does not need to survive container restarts, unlike the write-off
// audit log, which must persist to enforce monetary idempotency. Each operation
// is stored in a Map; the pipeline runs step by step and pauses at manual
// checkpoints (pause_reminders, calendar_confirm) until confirmStep() is called.
//
// Select the blacklist category and agreement type (DON/EPR) at the START,
// together with the customer/loan IDs. Keep the individual step toggles.
// ----------------------------------------------------------------------------

const crypto = require('node:crypto');
const writeoff = require('../../writeoff-bridge');
const { pick, hasColumn } = require('../../writeoff/src/exportReader');
const crmApi = require('./crmApi');
const sheets = require('./sheets');
const calendarForm = require('./calendarForm');
const { computeSchedule } = require('./schedule');
const { buildScheduleNote, writeoffNote } = require('./notes');
const { config } = require('./config');

const operations = new Map();

// --- step definitions --------------------------------------------------------
//
// toggleKey: null       -> required step that cannot be disabled (read_balance only).
// toggleKey: 'x'        -> step controlled by toggle 'x' (calendar_launch and
//                          calendar_confirm share the 'calendar' toggle).
// manual: true          -> step waits for operator confirmation (confirmStep).

const STEP_DEFS = [
  {
    name: 'read_balance', label: 'Čtení zůstatků', toggleKey: null,
    async run(op) {
      const { rows } = await writeoff.fetchCreditRows({
        customerId: op.input.customerId, creditId: op.input.creditId,
      });
      const balance = writeoff.buildBalance(writeoff.selectCreditRow(rows, op.input.creditId));
      op.balance = balance;
      return { debt: balance.debt };
    },
  },
  {
    name: 'sheets_write', label: 'Zápis do Google Sheets', toggleKey: 'sheets_write',
    async run(op) {
      return sheets.writeScheduleNote({ customerId: op.input.customerId, note: op.input.note });
    },
  },
  {
    name: 'category', label: `Kategorie klienta → ${config.CATEGORY_CUSTOMER}`, toggleKey: 'category',
    async run(op) {
      return crmApi.putCategory({ customerId: op.input.customerId, categoryId: config.CATEGORY_CUSTOMER });
    },
  },
  {
    name: 'credit_category', label: `Kategorie půjčky → ${config.CATEGORY_CREDIT}`, toggleKey: 'credit_category',
    async run(op) {
      return crmApi.putCreditCategory({ creditId: op.input.creditId, categoryId: config.CATEGORY_CREDIT });
    },
  },
  {
    name: 'pause_reminders', label: 'Pauza upomínek', toggleKey: 'pause_reminders', manual: true,
    prompt: 'Poznamenejte upomínky na pauzu v CRM ručně, poté potvrďte zde.',
    async run() { return { manual: true }; },
  },
  {
    name: 'writeoff', label: 'Odpis dluhu', toggleKey: 'writeoff',
    async run(op) {
      const plan = await writeoff.buildPlan({
        customerId: op.input.customerId, creditId: op.input.creditId, target: op.input.targetTotal,
      });
      if (!plan.ok) {
        const err = new Error('Odpis zablokovaly kontroly dat (viz findings).');
        err.code = 'writeoff_blocked';
        err.findings = plan.findings;
        throw err;
      }
      const result = await writeoff.applyPlan(plan, {
        live: true,
        actor: op.actor,
        notes: writeoffNote(op.input.type),
      });
      return { writeoffId: result.writeoffId || null, status: result.status };
    },
  },
  {
    name: 'calendar_launch', label: 'Formulář kalendáře', toggleKey: 'calendar',
    async run(op) {
      const { screenshot } = await calendarForm.fillCalendarForm(op.operationId, {
        customerId: op.input.customerId,
        creditId: op.input.creditId,
        startDate: op.input.schedule.startDate,
        schedule: op.input.schedule,
        note: op.input.note,
      });
      op.calendarScreenshot = screenshot;
      return { screenshotReady: true };
    },
  },
  {
    name: 'calendar_confirm', label: 'Potvrzení kalendáře', toggleKey: 'calendar', manual: true,
    prompt: 'Zkontrolujte screenshot vyplněného formuláře a potvrďte, že údaje souhlasí.',
    async run(op) {
      await calendarForm.confirmCalendarForm(op.operationId);
      op.calendarScreenshot = null;
      return { confirmed: true };
    },
  },
  {
    name: 'blacklist', label: 'Blacklist', toggleKey: 'blacklist',
    async run(op) {
      // CRM (customers/blacklist) does not accept "customerId" as an identifier;
      // it requires at least one unique customer field (phone, email, national
      // ID, account number, etc.; see crm_api.pdf). Read these from the raw export
      // row saved in read_balance (op.balance.raw), without another HTTP request.
      const uniqueFields = crmApi.resolveBlacklistUniqueFields(op.balance && op.balance.raw, { pick, hasColumn });
      return crmApi.postBlacklist({
        ...uniqueFields,
        reasonId: op.input.blacklistReasonId,
        description: config.BLACKLIST_NOTE,
      });
    },
  },
  {
    name: 'notes_final', label: 'Finální poznámky', toggleKey: 'notes_final',
    async run(op) {
      const customer = await crmApi.postCustomerNotes({ customerId: op.input.customerId, notes: op.input.note });
      const loan = await crmApi.postLoanNotes({ loanId: op.input.creditId, notes: op.input.note, userName: op.actor });
      return { customer, loan };
    },
  },
];

// --- helper functions --------------------------------------------------------

function newOperationId() { return crypto.randomUUID(); }

function serialize(op) {
  const steps = {};
  for (const def of STEP_DEFS) steps[def.name] = op.steps[def.name];
  return {
    operationId: op.operationId,
    status: op.status,
    waitingFor: op.waitingFor || null,
    prompt: op.prompt || null,
    failedAt: op.failedAt || null,
    error: op.error || null,
    steps,
    hasCalendarScreenshot: Boolean(op.calendarScreenshot),
  };
}

function markSkippedSteps(op) {
  for (const def of STEP_DEFS) {
    if (def.toggleKey && op.skipped.has(def.toggleKey)) {
      op.steps[def.name] = { status: 'skipped' };
    }
  }
}

// --- build and run operation -------------------------------------------------

function buildOperation({
  customerId, creditId, type, blacklistReasonId, targetTotal,
  calStartDate, calPerPayment, calTotal, skippedSteps, actor,
}) {
  if (!Object.prototype.hasOwnProperty.call(config.BLACKLIST_REASONS, Number(blacklistReasonId))) {
    const err = new Error(`Neplatné ID kategorie blacklistu: ${blacklistReasonId}`);
    err.code = 'reason_invalid';
    throw err;
  }

  const schedule = computeSchedule({ startDate: calStartDate, total: calTotal, perPayment: calPerPayment });
  if (!schedule.ok) {
    const err = new Error(`Chyba výpočtu harmonogramu: ${schedule.guards.map((g) => g.message).join('; ')}`);
    err.code = 'schedule_invalid';
    throw err;
  }
  const note = buildScheduleNote({ type, schedule });

  const op = {
    operationId: newOperationId(),
    createdAt: new Date().toISOString(),
    actor,
    input: {
      customerId: String(customerId), creditId: String(creditId), type,
      blacklistReasonId: Number(blacklistReasonId), targetTotal, schedule, note,
    },
    skipped: new Set(skippedSteps || []),
    steps: {},
    status: 'running',
    waitingFor: null,
    prompt: null,
    cursor: 0,
    calendarScreenshot: null,
  };
  for (const def of STEP_DEFS) op.steps[def.name] = { status: 'pending' };
  markSkippedSteps(op);
  operations.set(op.operationId, op);
  return op;
}

async function advance(op) {
  while (op.cursor < STEP_DEFS.length) {
    const def = STEP_DEFS[op.cursor];
    if (op.steps[def.name].status === 'skipped') { op.cursor += 1; continue; }

    if (def.manual && !op.steps[def.name].confirmed) {
      op.status = 'paused';
      op.waitingFor = def.name;
      op.prompt = def.prompt;
      op.steps[def.name] = { ...op.steps[def.name], status: 'active' };
      return;
    }

    op.steps[def.name] = { ...op.steps[def.name], status: 'active' };
    try {
      const result = await def.run(op);
      op.steps[def.name] = { status: 'done', result };
    } catch (err) {
      op.steps[def.name] = { status: 'failed', error: err.message, findings: err.findings || null };
      op.status = 'failed';
      op.failedAt = def.name;
      op.error = err.message;
      // If the calendar step fails, it may include a screenshot of the page
      // Playwright reached. Save it so the operator can view it using the same
      // /calendar-preview.png endpoint as a successful preview.
      if (err.debugScreenshot) op.calendarScreenshot = err.debugScreenshot;
      return;
    }
    op.cursor += 1;
  }
  op.status = 'complete';
  op.waitingFor = null;
  op.prompt = null;
}

async function start(input) {
  const op = buildOperation(input);
  await advance(op);
  return serialize(op);
}

async function confirmStep(operationId, stepName) {
  const op = operations.get(operationId);
  if (!op) {
    const err = new Error('Operace nenalezena (stav pipeline se nepamatuje na disk, po restartu serveru mizí).');
    err.code = 'operation_not_found';
    throw err;
  }
  if (op.status !== 'paused' || op.waitingFor !== stepName) {
    const err = new Error(`Krok "${stepName}" teď nečeká na potvrzení (aktuální stav: ${op.status}/${op.waitingFor}).`);
    err.code = 'step_not_waiting';
    throw err;
  }
  op.steps[stepName] = { ...op.steps[stepName], confirmed: true };
  await advance(op);
  return serialize(op);
}

function getStatus(operationId) {
  const op = operations.get(operationId);
  return op ? serialize(op) : null;
}

function getCalendarScreenshot(operationId) {
  const op = operations.get(operationId);
  return op ? op.calendarScreenshot : null;
}

module.exports = { start, confirmStep, getStatus, getCalendarScreenshot, STEP_DEFS };
