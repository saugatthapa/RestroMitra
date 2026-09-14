# Accounting Phase 7, Slice 7a — Cash Book / Bank Book

## What was built

Per `ACCOUNTING_PHASE_7_PLAN.md` Part 3's 7a, this slice adds the classic
bookkeeper's "Cash Book" / "Bank Book" report: pick an account, pick a date
range, and see an opening balance carried from before that range, every
transaction inside the range with a running balance, and a closing balance.

- One report generator, `getCashBookReport`, works for any account — "Cash
  Book" and "Bank Book" are the same report pointed at a different account,
  selected from a single dropdown in the UI, rather than two separate
  screens.
- The account picker (`listCashAndBankAccounts`) lists every seeded
  cash-like account (Cash on Hand, plus the legacy Bank/Digital Payments
  and Bank Account seeds) and every real bank account the restaurant has
  ever added via Slice 5b (active or not — a deactivated bank account's
  historical transactions are still real). It deliberately excludes
  clearing accounts and Accounts Receivable/Payable — those aren't "money
  in a drawer or bank," the same distinction the existing Cash Flow report
  (5c) already draws for what counts as cash.
- The new "Cash Book" tab sits alongside the existing report tabs
  (Trial Balance, P&L, Balance Sheet, Cash Flow, AR/AP Aging, VAT Return,
  Tax Depreciation).

This report is deliberately not new math. Phase 2's `getAccountLedger`
already computes one account's full running-balance history; this reuses
the exact same `signedBalance` arithmetic and the exact same opening-
balance source (`getAccountBalances`, already used by Cash Flow for the
same purpose) — just framed to a date range with an explicit opening
balance, rather than "since inception." It can never disagree with the
generic Ledger Accounts screen about the same account's history, because
it's the same computation.

## No design fork needed here

Unlike prior slices, this one didn't need an `AskUserQuestion` sign-off —
Part 2.2 of the Phase 7 plan already resolved the one real design choice
(one parameterized report vs. two separate ones) with clear reasoning, and
everything else was a direct extension of existing, already-tested
patterns (`getAccountBalances`, `signedBalance`, the Cash Flow report's own
cash-account resolution logic). Flagged here for completeness, since every
other slice report in this engagement has had a decision section.

## What changed, file by file

- **`src/lib/accounting/cash-book.ts`** (new) — `listCashAndBankAccounts(restaurantId)`
  (the picker) and `getCashBookReport({ restaurantId, accountId, fromDate,
  toDate })` (the report itself: opening balance, running-balance lines,
  closing balance, period debit/credit totals). Returns `null` if the
  account doesn't belong to the restaurant.
- **`src/app/api/restaurants/[slug]/accounting/reports/cash-book/route.ts`**
  (new) — `GET`, gated by `PERMISSIONS.MANAGE_ACCOUNTING`. Returns the
  picker's own options alongside the selected account's report in one
  response (no second round-trip just to populate the dropdown). Defaults
  `accountId` to the first available cash/bank account and the date range
  to the current calendar month, same "sensible default, not an error"
  convention every other report route in this module uses.
- **`src/app/dashboard/accounting/AccountingBoard.tsx`** — new "Cash Book"
  entry in `REPORT_TABS`; new `CashBookReport` component (account picker,
  date range, opening/closing balance rows, per-transaction table with a
  running balance column).
- **Tests**: `src/db/__tests__/accounting-cash-book.test.ts` (new, 4 tests)
  — opening balance carried correctly from before the report window, with
  a running balance walking forward through in-window transactions only
  (a transaction before or after the window affects the opening balance or
  is excluded entirely, but never appears as an in-window line); an empty
  period returns cleanly with opening = closing; an account belonging to a
  different restaurant returns `null` rather than leaking cross-tenant
  data; the account picker includes seeded cash accounts and a newly
  added real bank account, while excluding a clearing account and
  Accounts Receivable.

## Verification

- `npx tsc --noEmit` — clean.
- `npx eslint` on every touched file — clean.
- Targeted tests (`accounting-cash-book.test.ts`, `accounting-cash-flow.test.ts`,
  `check-constraints.test.ts`) — 14/14 passing.
- Full `npx vitest run` — 1630/1638 passing. The 8 failures are the same
  pre-existing, unrelated baseline seen in every prior slice's report in
  this engagement (`push-branch-filtering.test.ts` environment flakiness,
  and a hardcoded-port mismatch in the payment-gateway callback test) —
  none touch this slice's code.
- `npm run build` — succeeds cleanly.
- Dev-server smoke test: unauthenticated `GET` on
  `/api/restaurants/[slug]/accounting/reports/cash-book` → `401`; an
  unsupported method on the same route → `405`. No crash, no stack trace
  leak.

## Deliberately out of scope

- **Printing/export (PDF/CSV) of the Cash Book.** This slice is the report
  screen itself; a print/export affordance can be added later without
  changing the underlying computation, same as how other reports in this
  module currently have no dedicated export either.
- **A picker for non-cash/bank accounts.** The generic Ledger Accounts
  screen (Phase 2) already covers "any account's full history" — this
  report stays scoped to the specific bookkeeping artifact it's named
  after.

## What's next

Per `ACCOUNTING_PHASE_7_PLAN.md` Part 3, the next slice is **7b — branch
filtering on existing reports + a branch profitability view**. Lower risk
than this slice even: `branchId` already exists on every voucher and
chart-of-accounts row (a Phase 1 decision), so this is an additive
parameter on already-tested report generators, not new schema.
