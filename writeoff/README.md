# @fintech/writeoff

CRM debt write-off module. No user interface: library + CLI.

It does one thing end to end: reads a credit's balances, allocates the required
amount across buckets in the defined order, checks the result with guards, sends
the transaction to `special/writeoff`, and verifies that the debt reached its target.

```
npm test        # unit tests, no network, < 1 s
node bin/cli.js help
```

There are no dependencies beyond Node ≥ 18.18 (global `fetch` is required).

## How write-off amounts are calculated

The input is always **target**: the amount of debt that should **remain**. The
write-off amount is `debt − target`, allocated across buckets from top to bottom:

```
tax12 → tax11 → tax10 → tax9 → tax8 → tax7 → tax6 → tax2 → tax3 → tax4 → tax5 → tax1
      → charge → cinterest → late_fee → amount
```

Each bucket is cleared up to its remaining balance; the last affected bucket is
reduced only partially. Balances are read from columns prefixed with `l_` / `r_`
(remaining balance, not the amount charged):

| bucket | column | meaning |
|---|---|---|
| tax1…tax12 | `l_tax1`…`l_tax12` | taxes |
| cinterest | `l_cinterest` | zákonný úrok z prodlení |
| late_fee | `l_late_fee` | sml. pokuta |
| charge | `l_interest` | Cena / náklady — see explanation below |
| amount | `l_amount` | loan principal |

This mapping is defined in one place: `src/buckets.js`.

## Two known discrepancies

**1. `tax11` and `tax12` are supported by this module but are absent from the
published specification.** The `postWriteoff()` parameter table lists only
`tax1..tax10`. These fields may be enabled in a CRM installation, so they are
included in `PAYLOAD_FIELD`. Confirm their current availability before removing
them based on the PDF specification.

If the fields are not accepted, the API may still return `success` while silently
ignoring unknown parameters. Post-write verification detects this: it reads the
balance again, and if the debt is above target, the operation gets status
`applied_unverified` with a nonzero `delta`. The difference corresponds to the
unapplied `tax11` / `tax12` amounts.

The guard mechanism still works: `API_UNSUPPORTED` is derived from
`PAYLOAD_FIELD`, rather than maintained as a separate list. Removing a field
from the mapping makes its bucket non-writable and activates
`api_unsupported_bucket` automatically.

**2. The remaining `charge` balance is read from `l_interest`, not `r_charge`.**
The column labels do not match their meanings in this case, which can lead to an
incorrect balance mapping.

`r_charge` may look like the remaining Cena balance based on its name. Test
transactions showed the following behavior:

```
before write-off  debt 5200.00   r_charge 200.00   l_interest 200.00
write-off        charge 200.00  → accepted; debt decreased by 200.00
after write-off  debt 5000.00 = l_amount; r_charge still 200.00
```

`r_charge` does not decrease after a write-off: it is the amount charged.
Additional observations show that accrued `r_charge` may exceed current `debt`,
while a remaining balance cannot exceed the debt.

Until part of the Cena has been repaid, `l_interest` and `r_charge` are equal,
so the bucket sum matches `debt` and a wrong column mapping is not apparent.
The discrepancy appears after the first partial repayment.

The `debt_mismatch` guard compares the module's debt model with the system debt.
The `charge_source_suspicious` guard also fires if the remaining Cena exceeds
the amount charged. `probe` prints a “Reference” section with `charge`,
`o_charge`, `r_charge`, `interest`, `o_interest`, and `l_interest` to help
inspect this type of discrepancy.

## Main guard: reconciliation with system debt

Before any write-off, the module sums the remaining balances in all 16 buckets
and compares the result with system `debt`. Any difference triggers
`debt_mismatch`; the request is blocked, and `--force` cannot bypass it.

This is the only check that catches **all** column mapping errors at once:
the wrong column, a renamed vendor column, an omitted bucket, or a balance
stored in `l_interest` or `l_administrative_fee`. An allocation may look correct
with a wrong mapping, but the totals will not reconcile.

For this reason, the module requests `format=assoc` by default and resolves
columns by name. The export can also return flat arrays, where values are mapped
by the order of keys in `data.names`. This format is supported, but a mismatch
between a row's length and the number of names raises an error. An offset of one
element in positional format can produce an incorrect total in an otherwise
plausible report.

## Guard reference

| code | severity | condition |
|---|---|---|
| `debt_mismatch` | error, cannot be forced | bucket sum ≠ `debt` |
| `api_unsupported_bucket` | error, cannot be forced | waterfall affects a bucket without a contract field (none currently) |
| `target_invalid` | error, cannot be forced | target is not an integer or is negative |
| `nothing_to_write_off` | error | `debt ≤ target` |
| `insufficient_capacity` | error | bucket balances cannot reach the target |
| `missing_columns` | warning | column is missing from the export |
| `court_costs_included` | warning | tax9/tax10 are included in the write-off |
| `charge_source_suspicious` | warning | remaining Cena exceeds the amount charged |
| `prior_writeoff` | warning | the credit has prior write-offs |
| `debt_r_debt_mismatch` | warning | `debt` ≠ `r_debt` |
| `flag_sold`, `flag_archive` | warning | credit is sold / archived |

## Audit

The audit log is JSONL in `CRM_AUDIT_DIR` and is always written. The idempotency
key is the sha256 of `customerId + creditId + debt + target + allocation`;
notes and date are excluded so that changing the text does not create a new
write-off key.

**Blocking repeated write-offs is disabled by default** (`CRM_IDEMPOTENCY_GUARD`).
The CRM rejects a repeated write-off when the components have already been paid,
returning `invalidAmount`. The key also includes the debt amount, so it changes
after a successful write-off. A matching key can occur if the credit returns to
its previous state, such as in tests.

Enable it with `CRM_IDEMPOTENCY_GUARD=true`; then `applyPlan` returns
`already_applied` or `dangling_intent`, and `force: true` bypasses this block.
The flag is separate from `force`: `force` bypasses data guards, and allowing a
retry should not silently mean that data checks are ignored too.

One operation leaves a chain of records:

```
intent    written BEFORE the request
applied   API returned success
failed    API returned failed or the request threw an error
verified  balance reread: debt equals target
mismatch  balance reread: debt does NOT equal target
```

Writing `intent` before the request matters. If the process stops between
sending the request and receiving the response, the log contains an unfinished
attempt. A retry returns `dangling_intent` and requires a manual credit check
instead of sending a second write-off.

A successful API response is not enough: after `applied`, the balance is read
again. If the debt does not equal target, the operation is marked
`applied_unverified` and the CLI exits with code 2.

## CLI

```bash
export CRM_API_KEY=...
export CRM_ACTOR=demo_operator

# list the customer's credits and their balances
node bin/cli.js probe --customer 1001

# inspect one credit's buckets and reconcile with debt
node bin/cli.js probe --customer 1001 --credit 2001

# preview the write-off (sends nothing)
node bin/cli.js preview --customer 1001 --credit 2001 --target 25000

# dry-run: print the prepared request body without sending it
node bin/cli.js apply --customer 1001 --credit 2001 --target 25000

# apply the write-off
node bin/cli.js apply --customer 1001 --credit 2001 --target 25000 --live \
  --notes "staging - mam DoN, splatkovy kalendar"
```

Run `probe` on an initial live credit before other operations. It prints every
bucket, their sum, `debt`, and the difference, showing whether the column map is
correct.

## Using the module from code

```js
const { buildPlan, applyPlan, formatPlan } = require('@fintech/writeoff');

const plan = await buildPlan({
  customerId: 1001,
  creditId: 2001,
  target: 25000,                    // in crowns
  notes: 'staging - mam DoN',
});

console.log(formatPlan(plan));
if (!plan.ok) return plan;          // guards blocked the plan; stop here

const result = await applyPlan(plan, { live: true, actor: 'demo_operator' });
// result.status: applied | applied_unverified | already_applied | dangling_intent | dry_run
```

`buildPlan` has no side effects: a plan can be built, shown to an operator,
saved, and applied later. This separation makes the module suitable both as a
web route and as a standalone screen.

`computePlan` applies the same logic as a pure function of an existing `Balance`,
without network access. It is useful for tests and recalculating a plan from
data that has already been read.

## Configuration

All configuration comes from the environment; the key is never stored in code.
See `.env.example`.

Two settings are worth calling out:

- `CRM_AUTH_MODE` — `header` (x-api-key, as specified) or `query`
  (`?apiKey=`). The default is `header`.
- `CRM_WRITEOFF_TRANSPORT` — `body` or `query`. The parameter table in the
  specification does not distinguish query from body. The default is `body`.
  If the other transport is required, change this environment variable rather
  than the code.

## Open questions

- The write-off parameter transport (`body` versus `query`) should be checked
  with the first transaction on a safe `credit_id`.
- Check whether other columns have the same issue as `r_charge`. Any discrepancy
  is caught by `debt_mismatch`, but it is preferable to run `probe` on credits
  with partial repayments in each bucket in advance.
- `l_administrative_fee`, `l_penalty`, and `l_percent` are not part of the
  waterfall. They are zero in the credits checked so far. If any are nonzero,
  `debt_mismatch` blocks the write-off and shows them in the report; determine
  which write-off fields should clear them (`administrative_fee` and `penalty`
  are present in the contract).
