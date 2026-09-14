# Accounting Phase 5, Slice 5b — Bank Accounts & Bank-Statement Reconciliation

## What this slice builds

**Real bank accounts.** Previously the accounting module only knew two hardcoded
clearing accounts for non-cash money movement: "1040 Bank/Digital Payments" (used
by expense/payroll payouts) and "1045 Bank Account" (used by payment reconciliation).
A restaurant with two actual bank accounts had no way to tell them apart in the
books. This slice adds a real `bank_accounts` table — each row wraps its own child
`chart_of_accounts` row, parented under a new seeded grouping account **"1050 Bank
Accounts"**, with child codes allocated in a reserved **1051–1099** block. Bank
accounts can be added, edited, and deactivated from a new **Bank Accounts** tab.

**Silent-default resolution.** `resolveBankAccountForPosting` is the single place
that decides which ledger account a bank-shaped posting uses:
- Zero bank accounts set up yet → falls back to the old hardcoded mapping, so every
  existing restaurant behaves exactly as before until it visits the new screen.
- Exactly one active bank account → used silently, no picker shown anywhere.
- More than one active bank account → the caller must say which one; the three
  posting flows (expense payment, payroll payment, payment-reconciliation mark)
  and their UI forms all now support this.
- A bank account exists but none are active → posting is blocked with a clear
  error rather than silently falling back to the legacy account.

**Auto-wrap migration.** The first time any restaurant loads the Bank Accounts
screen, `ensureLegacyBankAccountsWrapped` runs automatically (idempotent, safe on
every load) and wraps whichever of 1040/1045 the restaurant actually has posted
activity against into a proper "…(default)" bank account row. An account that was
never used is left alone — no meaningless empty default gets created. Once any
`bank_accounts` row exists for a restaurant, this is a permanent no-op.

**Bank-statement reconciliation.** A distinct feature from the existing per-payment
reconciliation (Slice 4f): a human enters a statement date and closing balance for
one bank account, then checks off which of that account's own posted ledger lines
appeared on the real statement. Completing a reconciliation computes the cumulative
net of every line ever cleared against that account (across this and all prior
completed reconciliations, up to the statement date) and compares it to the
statement's closing balance — any difference is recorded and shown, never forced to
zero or blocked. Reconciliations can be reopened for correction; a completed one
can't be deleted, only reopened first.

**Picker wired into all three posting surfaces.** Once a restaurant has more than
one active bank account, a bank-account selector now appears:
- Expenses: both "add expense marked already paid" and the per-expense "Mark paid"
  action, only when the chosen payment method is bank-shaped (bank transfer /
  eSewa / Khalti / mobile banking).
- Payroll: the "Pay" modal, same bank-shaped-method condition.
- Account Books reconciliation: the "Mark reconciled" action, for **every**
  reconcilable method (card / mobile wallet / other) — unlike the other two flows,
  the debit side of a payment-reconciliation voucher is always the bank-account
  concept regardless of which method the customer paid with.

In every case, with zero or one active bank account the UI behaves exactly as it
did before this slice — no extra step, no picker shown.

## Two risks found and resolved before shipping

**Migration regression.** Auto-wrapping both 1040 and 1045 for a restaurant that's
used both payout-style payments and payment reconciliation would have created two
active bank accounts the moment it opened the new screen — and with no picker UI,
every subsequent expense/payroll/reconciliation action would have started throwing,
breaking a previously-working feature outright. Resolved by wiring the picker into
all three forms as part of this same slice, rather than shipping the migration
first and the picker later.

**RBAC gap.** `manager` holds `MANAGE_ACCOUNT_BOOKS` (needed to mark a payment
reconciled) but not `MANAGE_ACCOUNTING` (which gates the Bank Accounts admin list).
Reusing the admin route for the reconciliation picker would have either broken for
managers or required loosening a permission that also unlocks the Chart of
Accounts, Journal Vouchers, and Periods screens. Instead this slice adds a
minimal, redacted `listActiveBankAccountsForPicker` (id / bank name / code only —
no account number, no notes) behind its own lightweight route, gated specifically
by `MANAGE_ACCOUNT_BOOKS`.

## Also fixed along the way

- A raw `fetch(..., { method: "DELETE" })` in the reconciliation workspace UI was
  missing the CSRF header every other mutating call in this codebase sends —
  replaced with the existing `apiDelete` helper.
- A `.map()` returning a bare `<>...</>` fragment as a direct list child (no key on
  the fragment itself) in the new Bank Accounts table — replaced with
  `<Fragment key={...}>`.

## Verification

- `tsc --noEmit`: clean.
- `eslint .`: 0 errors (pre-existing unrelated warnings only, none in files this
  slice touched).
- `vitest run`: **1574 passed** (1563 baseline + 11 new: 7 in
  `accounting-bank-accounts.test.ts`, 4 in `accounting-bank-reconciliation.test.ts`).
  All 25 pre-existing accounting integration tests (expenses, payroll,
  reconciliation, posting) still pass unchanged, confirming backward compatibility.
  8 unrelated failures in `push-branch-filtering.test.ts` and the eSewa payment
  gateway callback test were present before this slice's changes and are
  environment/config issues (a port mismatch between the test's expected
  `localhost:3100` and the actual `localhost:3000`, and a branch-filtering
  assertion) — untouched by any file in this slice.
- `npm run build`: succeeds.
- Dev server smoke test: the three new routes
  (`.../accounting/bank-accounts`, `.../accounting/bank-reconciliations`,
  `.../reconciliation/bank-accounts`) all return a clean `401` unauthenticated.

## What this slice deliberately does not do

- No automatic bank feed / statement import — the closing balance and which lines
  cleared are entered by a human reading their own statement, same trust model as
  the rest of this module.
- No multi-currency support.
- No attempt to reconcile 1040/1045 retroactively beyond the one-time wrap — a
  restaurant with old activity on both keeps that history exactly as posted.
