# Accounting Module — Phase 5, Slice 5a Completion Report

Status: **Slice 5a (Accounts Receivable / Accounts Payable aging) complete**
— per `ACCOUNTING_PHASE_5_PLAN.md`'s own recommended build order (this
slice first: no blocking open decisions, and it's additive to, not a
replacement for, the existing Account Books reports).

## What was built

Two new read-only reports, **Accounts Payable aging** (by supplier) and
**Accounts Receivable aging** (by customer), plus a new "AR/AP Aging" tab
in the Reports section of the Accounting dashboard.

**The core complexity, discovered during implementation rather than
anticipated in the plan doc**: `accounting_voucher_lines` has no
`dueDate` column (unlike `ledger_entries`, which does), so aging can't be
a simple aggregation query — it requires replaying each party's full
debit/credit history and reconstructing which charges are still open.
`src/lib/accounting/aging.ts` does this with a FIFO subledger algorithm:
for each supplier/customer, it opens a dated "lot" for every charge
against the Accounts Payable/Receivable control account and consumes the
oldest open lot(s) first for every payment — the same oldest-first
allocation `settleLedgerDue`/`settleCustomerCredit` already use for the
existing single-entry ledger, not a new convention invented for this
report. An overpayment that exceeds every open lot becomes a running
credit balance (a real state — the restaurant paid a supplier more than
it owed, or a customer overpaid their tab) that offsets the *next* charge
rather than vanishing, and shows up as a negative figure in the report's
"Current" bucket.

**One deliberate simplification, stated plainly**: a voucher reversal
(a void) posts as an ordinary offsetting line on the same account/party,
not specially unwound against its own original lot — so a charge voided
long after other charges have accumulated nets against whatever's oldest
at the time, not necessarily itself. The *total* outstanding balance is
always exactly correct regardless (it's arithmetically just sum(charges)
− sum(payments) either way); only the bucket split could occasionally be
marginally off in that rare ordering. This is an acceptable trade-off for
a first cut, called out here so it isn't rediscovered as a surprise
later.

**Two new API routes** (`.../accounting/reports/ap-aging`,
`.../ar-aging`), same shape and permission gate
(`PERMISSIONS.MANAGE_ACCOUNTING`) as the existing Trial Balance/P&L/
Balance Sheet routes, with an optional `asOfDate` query param. Unlike
Phase 4's write-time `resolveAccountMappings` (which always throws on an
unmapped account, since every write-side caller already gates on
automatic posting being enabled first), this read-side report resolves
its control account with a small local helper that returns `null`
instead of throwing — a restaurant can open this report before ever
enabling automatic posting, and it should say "not set up yet," not
error.

**New "AR/AP Aging" tab** in `AccountingBoard.tsx`'s Reports section,
mirroring the existing Trial Balance/Balance Sheet components' shape (an
as-of-date input, a fetch-on-change effect, a bordered table) plus a
Payable/Receivable toggle. No drill-down here, unlike the other reports —
these rows are suppliers/customers, not chart-of-accounts entries, so
there's nowhere in the existing ledger drill-down view to send a click.

## Verification

- 6 new integration tests (`accounting-aging.test.ts`): a restaurant with
  no AP/AR account mapped yet returns `null` from both reports (not an
  error); a FIFO partial settlement correctly consumes the *oldest*
  charge first and splits the remaining balance across the correct age
  buckets; a fully-settled charge contributes nothing to its supplier's
  row; an overpayment produces a negative "Current"-bucket credit
  balance; the report's total is the sum of its own rows; the `asOfDate`
  parameter correctly excludes/includes a later-dated charge; and the
  Accounts Receivable mirror (customer-side) of the core case. All 6
  passed on the first run — no bugs surfaced this time, unlike every
  prior slice, which is worth naming rather than quietly taking credit
  for: the bucket-boundary arithmetic was worked out by hand before
  writing assertions, specifically because the "Current" bucket only
  covers age ≤ 0 days (i.e., dated exactly on the as-of date) rather than
  loosely "recent," which is easy to get wrong first try.
- Full suite: 1563 passed (up from 1557 — the 6 new tests), same 8
  pre-existing environment-only failures as every prior phase and slice
  (missing `GROQ_API_KEY`, dev `PORT` mismatch, push-branch-filtering) —
  confirmed unrelated, not a regression.
- `tsc --noEmit`, `eslint .`, `npm run build`: all clean.
- Live dev-server smoke test: both new routes
  (`/accounting/reports/ap-aging`, `/accounting/reports/ar-aging`) return
  a clean 401 for an unauthenticated request with a valid
  `x-restromitra-client` header (no 500s). Dev server stopped cleanly
  afterward; port 3000 confirmed free.

## What Slice 5a deliberately does NOT do

Doesn't touch or replace the existing `ledger_entries`-based Account
Books due/outstanding reports (`supplier-dues.ts`, `ledger.ts`) — those
keep working exactly as before, for every restaurant regardless of
whether they've enabled automatic posting. No new database schema, no
new triggers — this is a pure read-side report over data Phase 4's
integrations already write. No UI beyond the one new Reports tab (no
supplier/customer detail drill-down, no CSV export, no aging-based
collections workflow). No change to how AP/AR control accounts are
mapped or provisioned.

## Where this leaves Phase 5

Slice 5a is the first of five planned slices. Per the plan's own
sequencing, next up is **5b (Bank accounts + reconciliation upgrade)** —
which has several open decisions flagged in the plan (how existing
restaurants' single-default 1040/1045 accounts get migrated once real
multi-bank support lands, whether a first bank account still needs a
picker, and treating bank-statement-level reconciliation as its own
separately-scoped sub-feature) that should go through `AskUserQuestion`
before that slice starts, rather than being guessed at.

The small write-guard on account 3200 (flagged in Part 1.2 of the plan —
the Opening Balance Voucher route is meant to be the *only* thing ever
allowed to post to Owner's Capital's opening line, but the generic
Journal Voucher route currently has no such guard) remains an available,
not-yet-actioned follow-up, deliberately kept out of this slice's scope.
