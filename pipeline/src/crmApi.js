'use strict';

// ----------------------------------------------------------------------------
// Thin wrappers for CRM API operations not covered by the write-off module:
// category changes, notes, and blacklist. They use the same API contract
// (HTTP 200 != success; the actual result is in envelope.status; key in the
// x-api-key header). BASE_URL/API_KEY come from pipeline/src/config.js, which
// reads the existing write-off module configuration as the single source of truth.
//
// Verify these API details against the current CRM contract and installation:
//  - putCreditCategory: confirm the /api/v1.0/credits/category endpoint and
//    creditId/categoryId parameter names; they are inferred from the related
//    customers/category endpoint.
//  - postBlacklist: the endpoint may reject requests without at least one
//    unique customer identifier. It accepts personCode, idNumber,
//    accountNumber, ip, description, fullName, phone, phone2, email, email2,
//    source, adminId, reasonId, and date; at least one of personCode/idNumber/
//    accountNumber/phone/phone2/email/email2/ip is required. customerId and
//    notes are not accepted fields. Use the current crm_api.pdf contract to
//    confirm supported fields and required parameters.
// ----------------------------------------------------------------------------

const { config } = require('./config');

class PipelineApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'PipelineApiError';
    Object.assign(this, details);
  }
}

async function call(path, { method = 'GET', query = {}, body = null } = {}) {
  const url = new URL(config.BASE_URL.replace(/\/+$/, '') + path);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) {
      url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
  }

  const headers = { 'x-api-key': config.API_KEY, Accept: 'application/json' };
  const init = { method, headers };
  if (body) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.HTTP_TIMEOUT_MS);
  init.signal = ac.signal;

  let res;
  let text;
  try {
    res = await fetch(url, init);
    text = await res.text();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new PipelineApiError(`timeout ${config.HTTP_TIMEOUT_MS}ms: ${method} ${path}`, { path, method });
    }
    throw new PipelineApiError(`sitova chyba: ${method} ${path}: ${err.message}`, { path, method, cause: err });
  } finally {
    clearTimeout(timer);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new PipelineApiError(
      `odpoved neni JSON (HTTP ${res.status}) na ${method} ${path}: ${text.slice(0, 300)}`,
      { httpStatus: res.status, path, method },
    );
  }

  if (json.status !== 200) {
    throw new PipelineApiError(
      `API vratilo status=${json.status} na ${method} ${path}${json.message ? `: ${json.message}` : ''}`,
      { apiStatus: json.status, apiMessage: json.message, path, method },
    );
  }
  return json;
}

// Step 3: customer category (default 21 — payment schedule).
async function putCategory({ customerId, categoryId }) {
  return call('/api/v1.0/customers/category', {
    method: 'PUT',
    query: { customerId: Number(customerId), categoryId: Number(categoryId) },
  });
}

// Step 4: loan category (default 155). UNVERIFIED; see note above.
async function putCreditCategory({ creditId, categoryId }) {
  return call('/api/v1.0/credits/category', {
    method: 'PUT',
    query: { creditId: Number(creditId), categoryId: Number(categoryId) },
  });
}

// Step 10a: note on the customer profile.
async function postCustomerNotes({ customerId, notes }) {
  return call('/api/v1.0/special/customer-notes', {
    method: 'POST',
    query: { customerId: Number(customerId), notes },
  });
}

// Step 10b: note on the loan.
async function postLoanNotes({ loanId, notes, userName }) {
  const query = { loanId: Number(loanId), notes };
  if (userName) query.userName = userName;
  return call('/api/v1.0/special/loan-notes', { method: 'POST', query });
}

// Step 9: blacklist. According to crm_api.pdf, CRM requires at least one
// unique customer identifier (personCode/idNumber/accountNumber/phone/phone2/
// email/email2/ip); this endpoint does not accept customerId. The caller
// (orchestrator) resolves available fields from the export in step 1
// (read_balance) using resolveBlacklistUniqueFields below and passes them here.
async function postBlacklist({
  reasonId, description,
  personCode, idNumber, accountNumber, ip, phone, phone2, email, email2,
  fullName, source, adminId, date,
} = {}) {
  const unique = { personCode, idNumber, accountNumber, ip, phone, phone2, email, email2 };
  const hasUnique = Object.values(unique).some((v) => v !== undefined && v !== null && String(v).trim() !== '');
  if (!hasUnique) {
    throw new PipelineApiError(
      'postBlacklist: nebylo nalezeno zadne unikatni identifikacni pole klienta '
      + '(personCode/idNumber/accountNumber/phone/phone2/email/email2/ip) — CRM API '
      + '(customers/blacklist) bez nich vzdy vraci "InvalidArgument: No unique fields provided".',
      { code: 'no_unique_field' },
    );
  }

  const query = { reasonId: Number(reasonId) };
  if (description) query.description = description;
  for (const [k, v] of Object.entries({
    personCode, idNumber, accountNumber, ip, phone, phone2, email, email2, fullName, source,
  })) {
    if (v !== undefined && v !== null && String(v).trim() !== '') query[k] = v;
  }
  if (adminId !== undefined && adminId !== null && adminId !== '') query.adminId = Number(adminId);
  if (date) query.date = date;

  return call('/api/v1.0/customers/blacklist', { method: 'POST', query });
}

// Try to extract unique customer identifiers for postBlacklist from the raw
// export row (see writeoff/src/exportReader.js:pick). Exact column names in this
// export are not confirmed, so try likely alternatives for each field using the
// write-off module's pick rules (exact match or indexed name such as "phone_12").
// If no identifier is found, include all returned column names in the error to
// show the export schema and allow CANDIDATES to be updated.
function resolveBlacklistUniqueFields(raw, { pick, hasColumn }) {
  const CANDIDATES = {
    phone: ['phone', 'customer_phone', 'customers.phone', 'tel', 'telephone'],
    phone2: ['phone2', 'customer_phone2', 'customers.phone2'],
    email: ['email', 'customer_email', 'customers.email', 'mail'],
    email2: ['email2', 'customer_email2', 'customers.email2'],
    personCode: ['person_code', 'personCode', 'customers.person_code', 'birth_number', 'rodne_cislo'],
    idNumber: ['id_number', 'idNumber', 'customers.id_number', 'identity_card'],
    accountNumber: ['account_number', 'accountNumber', 'customers.account_number', 'bank_account'],
  };

  const found = {};
  for (const [field, columns] of Object.entries(CANDIDATES)) {
    for (const column of columns) {
      if (hasColumn(raw, column)) {
        const value = pick(raw, column);
        if (value !== undefined && value !== null && String(value).trim() !== '') {
          found[field] = value;
          break;
        }
      }
    }
  }

  if (Object.keys(found).length === 0) {
    const err = new PipelineApiError(
      'V exportu klienta se nenasel zadny sloupec s telefonem/e-mailem/rodnym cislem/'
      + 'cislem uctu, ktery by CRM prijalo jako "unikatni pole" pro blacklist. '
      + `Skutecne sloupce v exportu: ${Object.keys(raw || {}).join(', ') || '(zadne)'}. `
      + 'Opravte CANDIDATES v resolveBlacklistUniqueFields (pipeline/src/crmApi.js) '
      + 'podle spravneho nazvu sloupce.',
      { code: 'no_unique_field', rawColumns: Object.keys(raw || {}) },
    );
    throw err;
  }
  return found;
}

module.exports = {
  call, PipelineApiError,
  putCategory, putCreditCategory, postCustomerNotes, postLoanNotes, postBlacklist,
  resolveBlacklistUniqueFields,
};
