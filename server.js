if (require.main === module && process.env.NODE_ENV !== 'test') require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const fs = require('fs');
const path = require('path');

const access = require('./access');
const writeoff = require('./writeoff-bridge');
const pipeline = require('./pipeline/src/orchestrator');
const mockCrm = require('./mock-crm');

const JWT_SECRET = (process.env.JWT_SECRET || '').trim();
if (JWT_SECRET.length < 32 || /replace_with|demo-secret|change/i.test(JWT_SECRET)) {
  console.error('❌  JWT_SECRET must be at least 32 characters and must not be a placeholder.');
  process.exit(1);
}
if (!mockCrm.isMockMode() && !(process.env.API_KEY || '').trim()) {
  console.error('❌  API_KEY is required when MOCK_MODE is disabled.');
  process.exit(1);
}

const app = express();
// Behind the single reverse proxy, use the forwarded client IP so rate limits do not see every user as the proxy.
app.set('trust proxy', 1);
// The UI currently contains inline scripts/styles; unsafe-inline is a known CSP limitation until the page is nonce-based.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      scriptSrc: ["'self'", 'cdnjs.cloudflare.com', "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'cdnjs.cloudflare.com'],
      imgSrc: ["'self'", 'data:', 'blob:'],
    },
  },
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Config ────────────────────────────────────────────────────────────────────
const USERS_FILE = process.env.USERS_FILE || path.join(__dirname, 'users.json');
const API_BASE = process.env.API_BASE_URL
  || 'https://api.example.test/api/v1.0/export/export';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '8h';
const PORT = process.env.PORT || 3000;
const LOANS_EXPORT_ID = Number(process.env.CRM_LOANS_EXPORT_ID || 101);
const PAYMENTS_EXPORT_ID = Number(process.env.CRM_PAYMENTS_EXPORT_ID || 102);

// Status keywords that flag a loan as "sold / assigned to collection"
const SOLD_KEYWORDS = (
  process.env.SOLD_STATUS_KEYWORDS || 'prodán,prodáno,prodana,sold,postoupeno,postoupená'
).split(',').map(s => s.trim().toLowerCase());

// ── Field-name mapping (configurable via .env) ────────────────────────────────
// Loans export (assoc field aliases)
const F_LOAN = {
  id: process.env.F_LOAN_ID || 'id_0',
  typ: process.env.F_LOAN_TYP || 'typ_produktu',
  status: process.env.F_LOAN_STATUS || 'credit_status',
  customerId: process.env.F_LOAN_CUSTOMER || 'customer_id_3',
  origin: process.env.F_LOAN_ORIGIN || 'origin_id_4',
  created: process.env.F_LOAN_CREATED || 'created_5',
  expire: process.env.F_LOAN_EXPIRE || 'expire_6',
  amount: process.env.F_LOAN_AMOUNT || 'amount_7',
  delay: process.env.F_LOAN_DELAY || 'delay_8',
  tax7: process.env.F_LOAN_TAX7 || 'tax7_9',      // castka_na_prodlouzeni
  charge: process.env.F_LOAN_CHARGE || 'charge_10',   // naklady_na_pujcku
  lateFee: process.env.F_LOAN_LATE_FEE || 'late_fee_11', // smluvni_pokuta
  cinterest: process.env.F_LOAN_CINTEREST || 'cinterest_12',// kompenzacni_urok
  upominky: process.env.F_LOAN_UPOMINKY || 'upominky',
  tax6: process.env.F_LOAN_TAX6 || 'tax6_14',     // inkasni_agentura
  tax8: process.env.F_LOAN_TAX8 || 'tax8_15',     // vymahani_ia
  debt: process.env.F_LOAN_DEBT || 'debt_16',
};

// Detailed payments export (one row per payment transaction)
// ALL financial fields here are per-row incremental — sum them.
// writeoff_30 is a credit-level field (credits.writeoff) — overwrite, not sum.
const F_PAY = {
  creditId: process.env.F_PAY_CREDIT_ID || 'credit_id_1',
  // Payment allocation fields (all incremental — SUM across rows)
  jistina: process.env.F_PAY_JISTINA || 'amount_4',
  prodlouzeni: process.env.F_PAY_PRODL || 'tax7_18',
  naklady: process.env.F_PAY_NAKLADY || 'charge_5',
  pokuta: process.env.F_PAY_POKUTA || 'late_fee_10',
  kompUrk: process.env.F_PAY_KOMP_URK || 'cinterest_7',
  // upominky = tax2 + tax3 + tax4 + tax5 (handled separately in loop)
  upominky1: process.env.F_PAY_UPOM1 || 'tax2_13',
  upominky2: process.env.F_PAY_UPOM2 || 'tax3_14',
  upominky3: process.env.F_PAY_UPOM3 || 'tax4_15',
  upominky4: process.env.F_PAY_UPOM4 || 'tax5_16',
  inkasni: process.env.F_PAY_INKASNI || 'tax6_17',
  vymahani: process.env.F_PAY_VYMAHANI || 'tax8_19',
  // Credit-level field (overwrite, not sum)
  writeoff: process.env.F_PAY_WRITEOFF || 'writeoff_30',
};

// All financial fields in the payments export — used to compute total platba per row
const ALL_FINANCIAL_INDICES = [
  'amount_4', 'charge_5', 'administrative_fee_6', 'cinterest_7', 'interest_8',
  'insurance_9', 'late_fee_10', 'penalty_11',
  'tax1_12', 'tax2_13', 'tax3_14', 'tax4_15', 'tax5_16', 'tax6_17', 'tax7_18',
  'tax8_19', 'tax9_20', 'tax10_21', 'tax11_22', 'tax12_23',
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function loadUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) return [];
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
  } catch { return []; }
}

/**
 * Safely extract the rows array from a CRM API response.
 * Handles multiple known response shapes.
 */
function extractRows(apiResponse) {
  const d = apiResponse?.data;
  if (!d) return [];
  if (Array.isArray(d)) return d;
  if (Array.isArray(d.rows)) return d.rows;
  if (d.data && Array.isArray(d.data)) return d.data;
  for (const key of Object.keys(d)) {
    if (Array.isArray(d[key]) && key !== 'names') return d[key];
  }
  return [];
}

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);

    // Read the role from users.json, not the token, even though it is stored there.
    //
    // Tokens last 8 hours. If we trust the role inside the token, revoked
    // permissions would take effect only after expiry, leaving a demoted
    // operator with write-off access for most of a workday. For a system that
    // moves money, permission revocation must take effect immediately.
    //
    // The file is small and already read at login, so reading it per request is
    // inexpensive. Removing a user from users.json also revokes access immediately.
    const user = loadUsers().find((u) => String(u.id) === String(payload.id));
    if (!user) return res.status(401).json({ error: 'Uživatel již neexistuje' });

    req.user = {
      id: user.id,
      username: user.username,
      role: access.normalizeRole(user.role),
    };
    next();
  } catch {
    res.status(401).json({ error: 'Token expired or invalid' });
  }
}

// ── Permissions ──────────────────────────────────────────────────────────────
// Check permissions on every route. A hidden interface tab is a convenience,
// not security; without this layer, the mail role could invoke write-off with curl.
function requireCap(cap) {
  return function (req, res, next) {
    if (!access.can(req.user && req.user.role, cap)) {
      return res.status(403).json({ error: 'K této akci nemáte oprávnění' });
    }
    next();
  };
}

// ── Rate limiting on login ────────────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Příliš mnoho pokusů o přihlášení. Zkuste to znovu za 15 minut.' },
});

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /auth/login
app.post('/auth/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Vyplňte uživatelské jméno a heslo' });
  }
  const users = loadUsers();
  const user = users.find(u => u.username === username);
  const dummyHash = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
  const ok = await bcrypt.compare(password, user ? user.password : dummyHash);
  if (!user) return res.status(401).json({ error: 'Nesprávné přihlašovací údaje' });
  if (!ok) return res.status(401).json({ error: 'Nesprávné přihlašovací údaje' });

  const role = access.normalizeRole(user.role);
  const token = jwt.sign(
    { id: user.id, username: user.username, role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
  res.json({ token, username: user.username, role, caps: access.capsOf(role) });
});

// GET /auth/me — return the current user and capabilities. The frontend renders
// tabs from this response rather than its own role table, avoiding conflicting
// sources of truth that could grant excess access.
app.get('/auth/me', requireAuth, (req, res) => {
  res.json({
    username: req.user.username,
    role: req.user.role,
    caps: access.capsOf(req.user.role),
  });
});

// GET /api/client/:customerId
app.get('/api/client/:customerId', requireAuth, requireCap(access.CAPS.PREHLED), async (req, res) => {
  const { customerId } = req.params;
  if (!/^\d+$/.test(customerId)) {
    return res.status(400).json({ error: 'Neplatné ID klienta' });
  }

  if (mockCrm.isMockMode()) {
    return res.json(mockCrm.getMockClientData(customerId));
  }

  const filter = JSON.stringify([
    { name: 'customers.customer_id', act: '=', value: customerId }
  ]);
  const reqParams = { apiKey: process.env.API_KEY, filter, format: 'assoc' };

  try {
    const [loansRes, paymentsRes] = await Promise.all([
      axios.get(API_BASE, { params: { ...reqParams, id: LOANS_EXPORT_ID }, timeout: 15000 }),
      axios.get(API_BASE, { params: { ...reqParams, id: PAYMENTS_EXPORT_ID }, timeout: 15000 }),
    ]);

    if (loansRes.data?.status && loansRes.data.status !== 200) {
      return res.status(502).json({
        error: `CRM API vrátilo chybu: ${loansRes.data.message || 'neznámá'}`,
      });
    }

    const result = mergeData(loansRes.data, paymentsRes.data, customerId);
    res.json(result);

  } catch (err) {
    console.error('[API Error]', err.message);
    const status = err.response?.status || 500;
    res.status(status).json({ error: 'Chyba při načítání dat z CRM', details: err.message });
  }
});

// ── Data merge ────────────────────────────────────────────────────────────────

// (ALLOC_FIELDS removed — payments export uses direct per-row summation, see payMap loop)

function mergeData(loansRaw, paymentsRaw, customerId) {
  const loanRows = extractRows(loansRaw);
  const paymentRows = extractRows(paymentsRaw);

  // ── Aggregate payment rows by credit_id ─────────────────────────────────────
  // The payments export has one row per payment transaction. ALL fields are
  // incremental — each row represents a distinct payment event, so we SUM them.
  // Exception: writeoff_30 is credits.writeoff (credit-level) — OVERWRITE.
  const payMap = {};

  for (const row of paymentRows) {
    const cid = String(row[F_PAY.creditId] ?? '');
    if (!cid) continue;

    if (!payMap[cid]) {
      payMap[cid] = {
        platba: 0, uhrJist: 0, prodlouzeni: 0, naklady: 0,
        pokuta: 0, kompUrk: 0, upominky: 0, inkasni: 0, vymahani: 0,
        writeoff: 0,
      };
    }

    // platba = sum of ALL financial fields in this row
    payMap[cid].platba += ALL_FINANCIAL_INDICES.reduce(
      (s, f) => s + Number(row[f] || 0), 0
    );

    // Individual breakdown fields — SUM across rows
    payMap[cid].uhrJist += Number(row[F_PAY.jistina] || 0);
    payMap[cid].prodlouzeni += Number(row[F_PAY.prodlouzeni] || 0);
    payMap[cid].naklady += Number(row[F_PAY.naklady] || 0);
    payMap[cid].pokuta += Number(row[F_PAY.pokuta] || 0);
    payMap[cid].kompUrk += Number(row[F_PAY.kompUrk] || 0);
    payMap[cid].upominky += Number(row[F_PAY.upominky1] || 0)
      + Number(row[F_PAY.upominky2] || 0)
      + Number(row[F_PAY.upominky3] || 0)
      + Number(row[F_PAY.upominky4] || 0);
    payMap[cid].inkasni += Number(row[F_PAY.inkasni] || 0);
    payMap[cid].vymahani += Number(row[F_PAY.vymahani] || 0);

    // writeoff is a credit-level field — OVERWRITE
    payMap[cid].writeoff = Number(row[F_PAY.writeoff] || 0);
  }

  // ── Map loan rows ──────────────────────────────────────────────────────────
  const loans = loanRows.map(l => {
    const cid = String(l[F_LOAN.id] ?? '');
    const paid = payMap[cid] ?? {
      platba: 0, uhrJist: 0, prodlouzeni: 0, naklady: 0,
      pokuta: 0, kompUrk: 0, upominky: 0, inkasni: 0, vymahani: 0, writeoff: 0,
    };

    // Extension loans: origin_id is non-zero / non-empty
    const originRaw = l[F_LOAN.origin];
    const isExtension = originRaw !== null && originRaw !== undefined
      && String(originRaw).trim() !== ''
      && String(originRaw).trim() !== '0';

    // "Sold to collection" detection
    const statusStr = String(l[F_LOAN.status] ?? '');
    const prodan = SOLD_KEYWORDS.some(kw => statusStr.toLowerCase().includes(kw));

    // platba = how much was actually applied to this credit's components.
    // payment_amount_2 is the FULL transaction size and gets recorded against
    // multiple credits simultaneously — summing it per credit double-counts.
    // The _pokryto fields (allocSum) are the correct per-credit paid amount.
    const platba = paid.platba || 0;

    return {
      id: cid,
      product: String(l[F_LOAN.typ] ?? '—'),
      status: statusStr,
      prodan,
      klient: Number(l[F_LOAN.customerId] ?? customerId),
      origin: isExtension ? String(originRaw) : null,
      schval: String(l[F_LOAN.created] ?? '—'),
      splatn: String(l[F_LOAN.expire] ?? '—'),
      vprodl: Number(l[F_LOAN.delay] || 0),
      jistina: Number(l[F_LOAN.amount] || 0),
      platba,
      uhrJist: paid.uhrJist || 0,
      writeoff: paid.writeoff || 0,
      // ── Pair columns (issued / paid) ──
      castProd: Number(l[F_LOAN.tax7] || 0),
      castProdU: paid.prodlouzeni || 0,
      naklPujc: Number(l[F_LOAN.charge] || 0),
      naklPujcU: paid.naklady || 0,
      smlPok: Number(l[F_LOAN.lateFee] || 0),
      smlPokU: paid.pokuta || 0,
      kompUrk: Number(l[F_LOAN.cinterest] || 0),
      kompUrkU: paid.kompUrk || 0,
      upomink: Number(l[F_LOAN.upominky] || 0),
      upominkU: paid.upominky || 0,
      inkasni: Number(l[F_LOAN.tax6] || 0),
      inkasniU: paid.inkasni || 0,
      vymah: Number(l[F_LOAN.tax8] || 0),
      vymahU: paid.vymahani || 0,
      dluh: Number(l[F_LOAN.debt] || 0),
    };
  });

  const totalJistina = loans.filter(l => !l.origin).reduce((s, l) => s + l.jistina, 0);
  const hasWriteoff = loans.some(l => l.writeoff > 0);

  // Mark original loans whose chain still has outstanding debt.
  // naklPujc (charge_10) is the contracted fee — it belongs to the total only
  // once the chain is closed (fee has been applied / loan repaid).
  const originOf = Object.fromEntries(loans.filter(l => l.origin).map(l => [l.id, l.origin]));
  function findRoot(id) { while (originOf[id]) id = originOf[id]; return id; }
  const openRootIds = new Set(loans.filter(l => l.dluh > 0).map(l => findRoot(l.id)));
  // hasChildren: originals that actually have extensions (real chain parents)
  const hasChildren = new Set(loans.filter(l => l.origin).map(l => l.origin));
  for (const l of loans) l.chainOpen = openRootIds.has(l.id) && hasChildren.has(l.id);

  return {
    customerId,
    loans,
    totalJistina,
    hasWriteoff,
    meta: { loanCount: loans.length },
  };
}

// ── Users ────────────────────────────────────────────────────────────────────
// Read-only access and role changes only. User creation and password changes
// remain in `npm run add-user`, which requires server access and keeps passwords
// out of the browser.

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2) + '\n');
}

app.get('/api/users', requireAuth, requireCap(access.CAPS.USERS), (req, res) => {
  const users = loadUsers().map((u) => {
    const role = access.normalizeRole(u.role);
    return {
      id: u.id,
      username: u.username,
      role,
      caps: access.capsOf(role),
      createdAt: u.createdAt || null,
      roleMissing: !u.role,
    };
  });
  res.json({ users, roles: access.ROLES, roleCaps: access.ROLE_CAPS, me: req.user.username });
});

app.patch('/api/users/:id/role', requireAuth, requireCap(access.CAPS.USERS), (req, res) => {
  const { role } = req.body || {};
  if (!access.ROLES.includes(role)) {
    return res.status(400).json({ error: `Neznámá role. Povolené: ${access.ROLES.join(', ')}` });
  }

  const users = loadUsers();
  const target = users.find((u) => String(u.id) === String(req.params.id));
  if (!target) return res.status(404).json({ error: 'Uživatel nenalezen' });

  const previous = access.normalizeRole(target.role);
  if (previous === role) return res.json({ ok: true, unchanged: true, role });

  // Prevent self-lockout: the last administrator cannot lose that role, or no
  // one could manage permissions without editing users.json on the server.
  const adminsAfter = users.filter((u) => {
    const r = String(u.id) === String(target.id) ? role : access.normalizeRole(u.role);
    return r === 'admin';
  }).length;
  if (adminsAfter === 0) {
    return res.status(409).json({
      error: 'Nelze odebrat roli poslednímu administrátorovi — nikdo by pak nemohl spravovat práva.',
    });
  }

  target.role = role;
  saveUsers(users);

  console.log(`[users] ${req.user.username} změnil roli ${target.username}: ${previous} -> ${role}`);
  res.json({ ok: true, role, previous, username: target.username });
});

// ══════════════════════════════════════════════════════════════════════════════
// Debt write-off is the only part of the site that writes to the CRM.
//
// These routes follow three rules:
//
//  1. Do not trust a plan from the browser. apply receives only IDs, target
//     balance, and the idempotency key shown to the operator. The server rebuilds
//     the plan from a fresh export; if the keys differ, balances changed since
//     the preview, so return 409 instead of applying a stale plan from an idle tab.
//
//  2. Read the operator from the token, not the request body, or the audit log
//     would prove nothing.
//
//  3. Module guards block the operation; they are not warnings. There is no
//     force option here: a blocked plan returns 409 with findings, and the
//     operator investigates with probe. Only the CLI can bypass eligible guards.
// ══════════════════════════════════════════════════════════════════════════════

const { money } = writeoff;

// Write-off moves money, so it has a separate rate limit from login.
const writeoffLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Příliš mnoho požadavků. Zkuste to za minutu.' },
});

function isId(value) {
  return /^\d+$/.test(String(value || ''));
}

// Return amounts both as minor units for logic and strings for display.
// The client must not calculate money itself, using floats or otherwise.
function kc(minor) {
  return { minor, text: money.fromMinor(minor) };
}

function serializeBalance(balance) {
  const buckets = {};
  for (const bucket of writeoff.buckets.ORDER) {
    buckets[bucket] = {
      column: writeoff.buckets.SOURCE_COLUMN[bucket],
      remaining: kc(balance.buckets[bucket] || 0),
    };
  }
  const diagnostics = {};
  for (const [column, value] of Object.entries(balance.diagnostics || {})) {
    diagnostics[column] = value.raw;
  }
  const outOfWaterfall = {};
  for (const [column, value] of Object.entries(balance.outOfWaterfall || {})) {
    outOfWaterfall[column] = kc(value);
  }
  return {
    customerId: balance.customerId,
    creditId: balance.creditId,
    debt: kc(balance.debt),
    bucketSum: kc(balance.bucketSum),
    delta: kc(balance.bucketSum - balance.debt),
    reconciled: balance.bucketSum === balance.debt,
    buckets,
    order: writeoff.buckets.ORDER,
    diagnostics,
    outOfWaterfall,
    missingColumns: balance.missingColumns,
    meta: balance.meta,
  };
}

function serializePlan(plan) {
  const rows = writeoff.buckets.ORDER.map((bucket) => {
    const remaining = plan.buckets[bucket] || 0;
    const take = plan.allocation[bucket] || 0;
    return {
      bucket,
      column: writeoff.buckets.SOURCE_COLUMN[bucket],
      remaining: kc(remaining),
      take: take ? kc(take) : null,
      rest: kc(remaining - take),
    };
  });
  return {
    customerId: plan.customerId,
    creditId: plan.creditId,
    debtBefore: kc(plan.debtBefore),
    target: kc(plan.target),
    amount: kc(plan.amount),
    capacity: kc(plan.capacity),
    shortfall: kc(plan.shortfall),
    debtAfterExpected: kc(plan.debtAfterExpected),
    rows,
    findings: plan.findings,
    ok: plan.ok,
    fatal: plan.fatal,
    idempotencyKey: plan.idempotencyKey,
  };
}

// CRM note. The operator name comes from the token so the credit record shows
// who performed the write-off, not only the internal log.
// Set the note timezone explicitly instead of using process-local time. The
// container has no TZ setting, so local time would be UTC. Intl handles daylight
// saving transitions, avoiding manual CEST/CET calculations.
const NOTE_TZ = process.env.NOTE_TIMEZONE || 'Europe/Prague';

// sv-SE uses the same timestamp format as other locale settings.
const noteStampFmt = new Intl.DateTimeFormat('sv-SE', {
  timeZone: NOTE_TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit',
});

function noteStamp(date = new Date()) {
  return noteStampFmt.format(date).replace(',', '');
}

// Format amounts using Czech conventions, e.g. "6 971,26". Replace the
// non-breaking space added by cs-CZ with a regular space because the note is
// sent to legacy PHP, where unusual whitespace is unnecessary.
function fmtKc(minor) {
  return (minor / 100)
    .toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .replace(/ /g, ' ');
}

function buildNotes(plan, actor, custom) {
  const head = `${noteStamp()} - odpis ${fmtKc(plan.amount)} Kč,`
    + ` zůstatek ${fmtKc(plan.target)} Kč`;
  const middle = custom ? ` · ${String(custom).slice(0, 200)}` : '';
  const tail = actor ? ` [${actor}]` : '';
  return `${head}${middle}${tail}`;
}

function sendWriteoffError(res, err) {
  const name = err && err.name;
  if (name === 'MoneyError' || name === 'TypeError') {
    return res.status(400).json({ error: err.message });
  }
  if (name === 'ExportError') {
    // “Not found”, “two rows returned”, and “ambiguous column” all mean the
    // data differs from our assumptions.
    return res.status(409).json({ error: err.message });
  }
  if (name === 'WriteoffError') {
    return res.status(409).json({ error: err.message, findings: err.findings || null });
  }
  if (name === 'ApiError') {
    return res.status(502).json({ error: `CRM API: ${err.message}` });
  }
  console.error('[writeoff]', err);
  return res.status(500).json({ error: 'Neočekávaná chyba při odpisu' });
}

// GET /api/writeoff/credits/:customerId
// Customer credits with nonzero debt. The CC role cannot view "Přehled půjček",
// so it selects a credit here rather than from the table.
app.get('/api/writeoff/credits/:customerId', requireAuth, requireCap(access.CAPS.WRITEOFF),
  writeoffLimiter, async (req, res) => {
    const { customerId } = req.params;
    if (!isId(customerId)) return res.status(400).json({ error: 'Neplatné ID klienta' });
    try {
      const { rows } = await writeoff.fetchCreditRows({ customerId });
      const credits = writeoff.listDebtors(rows)
        .map((entry) => ({ creditId: entry.creditId, debt: kc(entry.debt) }))
        .sort((a, b) => b.debt.minor - a.debt.minor);
      res.json({ customerId, credits, total: rows.length });
    } catch (err) {
      sendWriteoffError(res, err);
    }
  });

// GET /api/writeoff/balance/:customerId/:creditId
// probe: bucket balances, reconciliation with system debt, and diagnostics.
app.get('/api/writeoff/balance/:customerId/:creditId', requireAuth,
  requireCap(access.CAPS.WRITEOFF), writeoffLimiter, async (req, res) => {
    const { customerId, creditId } = req.params;
    if (!isId(customerId) || !isId(creditId)) {
      return res.status(400).json({ error: 'Neplatné ID' });
    }
    try {
      const { rows } = await writeoff.fetchCreditRows({ customerId, creditId });
      const balance = writeoff.buildBalance(writeoff.selectCreditRow(rows, creditId));
      res.json(serializeBalance(balance));
    } catch (err) {
      sendWriteoffError(res, err);
    }
  });

// POST /api/writeoff/preview { customerId, creditId, target }
// No side effects; this can be run repeatedly.
app.post('/api/writeoff/preview', requireAuth, requireCap(access.CAPS.WRITEOFF),
  writeoffLimiter, async (req, res) => {
    const { customerId, creditId, target } = req.body || {};
    if (!isId(customerId) || !isId(creditId)) {
      return res.status(400).json({ error: 'Neplatné ID' });
    }
    if (target === undefined || target === null || target === '') {
      return res.status(400).json({ error: 'Zadejte cílový zůstatek' });
    }
    try {
      const plan = await writeoff.buildPlan({ customerId, creditId, target });
      res.json(serializePlan(plan));
    } catch (err) {
      sendWriteoffError(res, err);
    }
  });

// POST /api/writeoff/apply { customerId, creditId, target, idempotencyKey, notes? }
// The only route on the site that moves money.
app.post('/api/writeoff/apply', requireAuth, requireCap(access.CAPS.WRITEOFF),
  writeoffLimiter, async (req, res) => {
    const { customerId, creditId, target, idempotencyKey, notes } = req.body || {};
    if (!isId(customerId) || !isId(creditId)) {
      return res.status(400).json({ error: 'Neplatné ID' });
    }
    if (!idempotencyKey) {
      return res.status(400).json({ error: 'Chybí idempotencyKey z náhledu' });
    }

    try {
      // Rebuild the plan; do not trust the browser's version.
      const plan = await writeoff.buildPlan({ customerId, creditId, target });

      if (plan.idempotencyKey !== idempotencyKey) {
        return res.status(409).json({
          error: 'Zůstatky se od náhledu změnily. Zkontrolujte nový návrh a potvrďte znovu.',
          code: 'plan_changed',
          plan: serializePlan(plan),
        });
      }
      if (!plan.ok) {
        return res.status(409).json({
          error: 'Odpis zablokovaly kontroly dat.',
          code: 'blocked',
          plan: serializePlan(plan),
        });
      }

      const result = await writeoff.applyPlan(plan, {
        live: true,
        actor: req.user.username,
        notes: buildNotes(plan, req.user.username, notes),
      });

      const payload = {
        status: result.status,
        message: result.message || null,
        writeoffId: result.writeoffId || null,
        plan: serializePlan(plan),
        verification: result.verification
          ? {
            ok: result.verification.ok,
            debtAfter: kc(result.verification.debtAfter),
            expectedDebt: kc(result.verification.expectedDebt),
            delta: kc(result.verification.delta),
          }
          : null,
        previous: result.previous || null,
      };

      // applied_unverified and dangling_intent require manual review.
      // Return 409 so the frontend does not display them as successful.
      const needsHuman = ['applied_unverified', 'dangling_intent'].includes(result.status);
      res.status(needsHuman ? 409 : 200).json(payload);

    } catch (err) {
      sendWriteoffError(res, err);
    }
  });


// ══════════════════════════════════════════════════════════════════════════════
// "Splátkový kalendář" (payment schedule) pipeline, steps 1-10.
//
// Autosearch pujcek s dluhem pouziva stejnou routu jako zalozka Odpis dluhu
// (GET /api/writeoff/credits/:customerId) — kdo ma cap PIPELINE, ma podle
// access.js vzdy i cap WRITEOFF, takze samostatna kopie routy by jen
// duplikovala kod bez duvodu.
//
// Stav operace zije v pameti procesu (pipeline/src/orchestrator.js) — pri
// restartu serveru operace mizi, viz komentar tamtez.
// ══════════════════════════════════════════════════════════════════════════════

const pipelineLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Příliš mnoho požadavků. Zkuste to za minutu.' },
});

function sendPipelineError(res, err) {
  const code = err && err.code;
  if (code === 'schedule_invalid' || code === 'reason_invalid') {
    return res.status(400).json({ error: err.message, code });
  }
  if (code === 'sheet_row_not_found' || code === 'writeoff_blocked'
    || code === 'operation_not_found' || code === 'step_not_waiting') {
    return res.status(409).json({ error: err.message, code, findings: err.findings || null });
  }
  console.error('[pipeline]', err);
  res.status(500).json({ error: err && err.message ? err.message : 'Neočekávaná chyba v pipeline' });
}

// POST /api/pipeline/start
app.post('/api/pipeline/start', requireAuth, requireCap(access.CAPS.PIPELINE), pipelineLimiter,
  async (req, res) => {
    const {
      customerId, creditId, type, blacklistReasonId,
      targetTotal, calStartDate, calPerPayment, calTotal, skippedSteps,
    } = req.body || {};

    if (!isId(customerId) || !isId(creditId)) {
      return res.status(400).json({ error: 'Neplatné ID' });
    }
    if (type !== 'DON' && type !== 'EPR') {
      return res.status(400).json({ error: 'type musí být DON nebo EPR' });
    }

    try {
      const result = await pipeline.start({
        customerId, creditId, type,
        blacklistReasonId, targetTotal, calStartDate, calPerPayment, calTotal,
        skippedSteps: Array.isArray(skippedSteps) ? skippedSteps : [],
        actor: req.user.username,
      });
      res.json(result);
    } catch (err) {
      sendPipelineError(res, err);
    }
  });

// POST /api/pipeline/:operationId/confirm { step }
app.post('/api/pipeline/:operationId/confirm', requireAuth, requireCap(access.CAPS.PIPELINE), pipelineLimiter,
  async (req, res) => {
    const { step } = req.body || {};
    if (!step) return res.status(400).json({ error: 'Chybí step' });
    try {
      const result = await pipeline.confirmStep(req.params.operationId, step);
      res.json(result);
    } catch (err) {
      sendPipelineError(res, err);
    }
  });

// GET /api/pipeline/:operationId/status — obnoveni stavu po reloadu stranky.
app.get('/api/pipeline/:operationId/status', requireAuth, requireCap(access.CAPS.PIPELINE),
  (req, res) => {
    const result = pipeline.getStatus(req.params.operationId);
    if (!result) return res.status(404).json({ error: 'Operace nenalezena' });
    res.json(result);
  });

// GET /api/pipeline/:operationId/calendar-preview.png — screenshot vyplneneho
// formulare pro rucni potvrzeni kroku calendar_confirm.
app.get('/api/pipeline/:operationId/calendar-preview.png', requireAuth, requireCap(access.CAPS.PIPELINE),
  (req, res) => {
    const screenshot = pipeline.getCalendarScreenshot(req.params.operationId);
    if (!screenshot) return res.status(404).end();
    res.type('png').send(screenshot);
  });

// ── Start ─────────────────────────────────────────────────────────────────────
// Debug endpoint — returns raw CRM response for a customer.
// Returns the raw CRM response and field map, so only admins can access it;
// ordinary operators do not need internal column names.
app.get('/debug/:customerId', (req, res, next) => {
  if (mockCrm.isMockMode() || process.env.NODE_ENV === 'production') return res.sendStatus(404);
  if (!isId(req.params.customerId)) return res.sendStatus(404);
  next();
}, requireAuth, requireCap(access.CAPS.USERS), async (req, res) => {
  const filter = JSON.stringify([
    { name: 'customers.customer_id', act: '=', value: req.params.customerId }
  ]);
  const params = { apiKey: process.env.API_KEY, filter, format: 'assoc' };
  try {
    const [a, b] = await Promise.all([
      axios.get(API_BASE, { params: { ...params, id: LOANS_EXPORT_ID }, timeout: 15000 }),
      axios.get(API_BASE, { params: { ...params, id: PAYMENTS_EXPORT_ID }, timeout: 15000 }),
    ]);
    // Also expose which field-name mappings are active so you can verify them
    res.json({
      fieldMapping: { F_LOAN, F_PAY },
      loans_export: a.data,
      payments_export: b.data,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

if (require.main === module) app.listen(PORT, () => {
  console.log(`✅  Debt Portfolio Platform → http://localhost:${PORT}`);
  if (mockCrm.isMockMode()) {
    console.log('ℹ️   Running in MOCK MODE (Offline). Demo clients: 1001, 1002');
  }
});

module.exports = { app };
