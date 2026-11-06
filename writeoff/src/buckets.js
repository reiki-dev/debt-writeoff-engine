'use strict';

// ----------------------------------------------------------------------------
// The single source of truth for which column supplies each bucket, the order
// in which buckets are cleared, and the API field used for each one.
//
// The rest of the module does not hard-code bucket mappings. If a vendor export
// column is renamed or a writeoff field is added, update this file only.
// ----------------------------------------------------------------------------

// Write-off order (defined by the customer): from the highest tax buckets down
// to principal.
// tax12 -> tax6, then tax2 -> tax3 -> tax4 -> tax5 -> tax1, then charge (cena), cinterest, late_fee, amount.
const ORDER = [
  'tax12', 'tax11', 'tax10', 'tax9', 'tax8', 'tax7',
  'tax6', 'tax2', 'tax3', 'tax4', 'tax5', 'tax1',
  'charge',
  'cinterest',
  'late_fee',
  'amount',
];

// Bucket -> export column containing the REMAINING balance.
// In this export, l_ / r_ prefixes indicate a remaining balance, not an amount
// charged: tax8 is the total charged; l_tax8 is the unpaid part.
const SOURCE_COLUMN = {
  tax1: 'l_tax1', tax2: 'l_tax2', tax3: 'l_tax3', tax4: 'l_tax4',
  tax5: 'l_tax5', tax6: 'l_tax6', tax7: 'l_tax7', tax8: 'l_tax8',
  tax9: 'l_tax9', tax10: 'l_tax10', tax11: 'l_tax11', tax12: 'l_tax12',
  cinterest: 'l_cinterest',   // zákonný úrok z prodlení
  late_fee: 'l_late_fee',     // sml. pokuta
  charge: 'l_interest',       // Cena / náklady — see “About charge” below
  amount: 'l_amount',         // loan principal
};

// ── About charge ────────────────────────────────────────────────────────────
// The remaining Cena is read from l_interest, NOT r_charge, although it is
// sent in the charge field. The export column label is misleading; observations
// from test transactions show:
//
//   before write-off  l_interest matches r_charge
//   otpisali         charge 200.00  -> sistema prinyala, debt snizilsya na 200.00
//   after write-off   only l_amount remains, while r_charge is unchanged
//
// That is, r_charge does not decrease after a write-off; it is the amount
// charged, not the remaining balance. Another test credit showed that r_charge
// Proverka potvrzuje, chto nachislenny charge mozhet byt vyshe tekushchego dolga.
//
// Until some Cena has been repaid, l_interest and r_charge are equal, and the
// bucket sum matches debt, so the wrong column is not apparent. The discrepancy
// appears only after the first partial repayment.
// ────────────────────────────────────────────────────────────────────────────

// Bucket -> parameter name in special/writeoff.
//
// DOCUMENTATION DISCREPANCY: the published postWriteoff() specification lists
// only tax1..tax10 and omits tax11/tax12 from its parameter table. These fields
// may be enabled in a CRM installation, so they are included here. Confirm their
// current availability before removing them based on the PDF.
//
// If the fields are not accepted, the API may return success while ignoring
// unknown parameters. Post-write verification in apply.js rereads the balance
// and returns applied_unverified if debt is above target.
const PAYLOAD_FIELD = {
  tax1: 'tax1', tax2: 'tax2', tax3: 'tax3', tax4: 'tax4', tax5: 'tax5',
  tax6: 'tax6', tax7: 'tax7', tax8: 'tax8', tax9: 'tax9', tax10: 'tax10',
  tax11: 'tax11', tax12: 'tax12',
  cinterest: 'cinterest',
  late_fee: 'late_fee',
  charge: 'charge',
  amount: 'amount',
};

// Buckets without fields in the writeoff contract. Derived from PAYLOAD_FIELD
// rather than maintained separately: removing a field above makes the bucket
// non-writable and activates `api_unsupported_bucket` automatically.
// The list is currently empty.
const API_UNSUPPORTED = ORDER.filter((b) => PAYLOAD_FIELD[b] === undefined);

// Balance columns excluded from the waterfall that may still be part of debt.
// If any are nonzero, the bucket sum will differ from debt and the
// `debt_mismatch` guard will catch it. Keep this list so the report shows where
// the discrepancy comes from, not just its total.
const OUT_OF_WATERFALL_COLUMNS = [
  'l_administrative_fee',
  'l_penalty',
  'l_percent',
  'l_s_amount',
  'l_s_interest',
  'l_s_administrative_fee',
];

// Reference columns printed by probe. They are NOT used in the waterfall or
// reconciliation, but help inspect Cena, where a column mapping was found to
// be incorrect.
const DIAGNOSTIC_COLUMNS = [
  'charge', 'o_charge', 'r_charge',
  'interest', 'o_interest', 'l_interest',
];

// Column containing system debt, the source of truth for reconciliation.
const DEBT_COLUMN = 'debt';

// Auxiliary columns fetched for reports and guards.
const META_COLUMNS = [
  'id', 'customer_id', 'debt', 'r_debt',
  'writeoff', 'writeoff_a', 'writeoff_l', 'writeoff_p',
  'court_date', 'cfg_court', 'sold', 'archive', 'important', 'current_delay',
];

module.exports = {
  ORDER,
  SOURCE_COLUMN,
  PAYLOAD_FIELD,
  API_UNSUPPORTED,
  OUT_OF_WATERFALL_COLUMNS,
  DIAGNOSTIC_COLUMNS,
  DEBT_COLUMN,
  META_COLUMNS,
};
