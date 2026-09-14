# Accounting Phase 7, Slice 7c — Accounting Audit/Journal Report

## What was built

Per `ACCOUNTING_PHASE_7_PLAN.md` Part 2.4/Part 3's 7c, this slice adds a
chronological, complete listing of every posted voucher in a date range —
date, voucher number, type, narration, status, and its full debit/credit
lines — the report a bookkeeper or auditor reaches for to review a period's
ledger activity in full, as distinct from the RBAC `audit_logs` table
(which answers "who changed what in the app," not "what did the books
record").

- A new "Journal" report tab, filterable by date range, voucher type, and
  (via the same header branch switcher every other Phase 7b report uses)
  branch.
- Each voucher expands, in place, to show its own lines — account, line
  description, debit, credit — with a running count and debit/credit
  totals across the whole filtered set.

## A check before building: is this redundant with the existing Vouchers tabs?

Before writing any code, I checked whether this duplicates the existing
"Journal Vouchers"/"Day Book" tabs (`VouchersTab`, backed by `GET
/accounting/vouchers`) — both already list vouchers with expandable lines.
Reading that route settled it: it caps at the **200 most recent** vouchers
restaurant-wide, with **no date-range filter and no branch filter** — it's
a working-set browsing list for day-to-day voucher management (reversing a
voucher, entering a new one), not a bounded "give me the complete journal
for period X" report. A restaurant with more than 200 vouchers in a month
literally cannot see its own full month there. This slice's report is
genuinely additive: complete (not capped), date-scoped, and branch-scoped,
matching the shape of every other Phase 5/6/7 report in this module. The
new report's UI deliberately mirrors the existing `VoucherRow`'s
expand/collapse look and feel for visual consistency, but its lines come
back already loaded with the report response (no per-row lazy fetch),
since completeness — not incremental browsing — is the point here.

## What changed, file by file

- **`src/lib/accounting/journal-report.ts`** (new) —
  `getJournalReport({ restaurantId, fromDate, toDate, branchId?,
  voucherType? })`. Two queries (vouchers in range, then their lines by
  `voucherId`), grouped in application code — same "simple aggregation,
  not a SQL GROUP BY" trade-off this module's `balances.ts` already
  documents for its own row counts. `branchId` filters
  `accounting_vouchers.branchId` directly, consistent with Slice 7b's own
  corrected design (filter the voucher, never the account).
- **`src/app/api/restaurants/[slug]/accounting/reports/journal/route.ts`**
  (new) — `GET`, gated `MANAGE_ACCOUNTING`. `fromDate`/`toDate` default to
  the current calendar month; `?voucherType=` validated against the
  existing `accountingVoucherTypeSchema`; `?branchId=` follows the exact
  same security pattern as every other Phase 7b report route
  (`requireBranchAccess`, forced to a branch-restricted caller's own
  grant).
- **`src/app/dashboard/accounting/AccountingBoard.tsx`** — new "Journal"
  entry in `REPORT_TABS`; new `JournalReportTab` component, reusing the
  existing `VOUCHER_TYPE_LABELS`/`STATUS_BADGE` constants and the same
  expand/collapse interaction `VoucherRow` already established, plus the
  `BranchScopeNote` convention from Slice 7b. Shows each voucher's own
  branch name in its expanded detail whenever more than one branch exists,
  so an "all branches" view stays traceable per voucher.
- **Tests**: `src/db/__tests__/accounting-journal-report.test.ts` (new, 4
  tests) — lists every voucher in range with correct lines/totals while
  excluding an out-of-range voucher; `voucherType` narrows correctly;
  `branchId` narrows to just that branch's own vouchers; an empty period
  returns a clean zeroed report rather than an error.

## Verification

- `npx tsc --noEmit` — clean.
- `npx eslint` on every touched file — clean.
- Targeted tests (`accounting-journal-report.test.ts`,
  `check-constraints.test.ts`) — 11/11 passing.
- Full `npx vitest run` — 1638/1646 passing. The 8 failures are the same
  pre-existing, unrelated baseline seen in every prior slice's report in
  this engagement — none touch this slice's code.
- `npm run build` — succeeds cleanly.
- Dev-server smoke test: unauthenticated `GET` on the new journal report
  route → `401`; an unsupported method → `405`. No crash, no stack trace
  leak.

## Deliberately out of scope

- **Printing/export (PDF/CSV) of the journal.** Same posture as the Cash
  Book report (7a) — this slice is the report screen itself; export can be
  layered on later without changing the underlying query.
- **Merging with the RBAC `audit_logs` viewer.** Deliberately kept
  separate — see the module's own top-of-file comment on why conflating
  "what the app recorded happened" with "who changed what in the app"
  would make both harder to use for their actual purpose.
- **Pagination/row limits.** Unlike the 200-row-capped browsing list this
  report is meant to replace for period review, a "complete journal for
  this period" report intentionally shows everything in range — a
  restaurant with an unusually high-volume period may want a narrower date
  range, not a truncated report that silently hides some vouchers.

## What's next

Per `ACCOUNTING_PHASE_7_PLAN.md` Part 3, the next slice is **7d —
Inventory Valuation**: a report exposing the Inventory account's own
ledger balance (as of a date, with a breakdown of what moved it in the
period) rather than inventing a second, independent costing method — see
the plan's own Part 2.3 for why that's the deliberate scope boundary.
