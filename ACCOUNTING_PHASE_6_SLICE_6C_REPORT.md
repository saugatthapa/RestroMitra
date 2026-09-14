# Accounting Phase 6, Slice 6c — VAT Return / Tax Summary Report

Per `ACCOUNTING_PHASE_6_PLAN.md`'s own Part 5, #3, this is the plan's
recommended, decision-independent companion to Slice 6a — it needs 6a's
Input VAT account to produce a real net-payable figure, and unlike 6b/6d
it needs no further sign-off before starting.

## What this slice builds

A read-only report, for a chosen period: **Output VAT** (net credits to
"2100 Tax Payable" — VAT collected on sales) minus **Input VAT** (net
debits to "1150 Input VAT Receivable" — VAT paid on VAT-inclusive
purchases, from Slice 6a), producing a net-payable (or net-refundable)
figure. No new schema — purely a new report over data every other Phase
4/5/6 integration already posts, the same "just read the ledger" approach
Slice 5c's Cash Flow Statement established.

Explicitly, per the plan's own Part 3 framing: **a reference summary for
the owner's/accountant's own use, never a claim of being a filable,
submittable IRD form.** The UI says so directly, and the module's own
top-of-file comment spells out exactly what "Output VAT" means here (it's
whatever tax rate a restaurant configured via `taxRateBasisPoints` —
this report calls it VAT because that's the Phase 6 plan's own scope, not
because the codebase enforces that the configured rate IS VAT).

## Design, and one limitation surfaced (not fixed) by writing it

Both figures are the account's **net movement over the period**, not a
running balance — a real VAT return is period-based ("what did I collect/
pay this month"), matching Slice 5c's own reasoning for using period
activity rather than point-in-time balances. Like Slice 5c's query, there
is deliberately no `status` filter on the voucher join: `reverseVoucher()`
never edits an original voucher, it posts a separate voucher with every
line swapped, so a reversed voucher's original lines and its reversal's
swapped lines are both included and net to exactly zero on their own.

Writing this surfaced a genuine, pre-existing gap this slice does **not**
fix: `postRefundVoucher` (Phase 4, Slice 4b) books a sales refund's full
amount to "4910 Sales Returns & Refunds" only — it never reduces "2100 Tax
Payable," a documented Phase 4 simplification (the payments/refund schema
has no field recording how much of a refund was ever tax). That means this
report's Output VAT figure does not subtract tax on refunded sales. A
restaurant with meaningful refund volume will see this report overstate
its true net Output VAT for the period. This is flagged plainly in both
the module's own code comment and the report's own on-screen note, rather
than silently accepted — fixing it would mean reworking Phase 4's own
refund posting, which is out of scope for a Phase 6 report slice.

## What changed

- **`src/lib/accounting/vat-return.ts`** (new) — `getVatReturnStatement`,
  reading net movement on "2100"/"1150" for a restaurant/period.
- **New route** — `GET /api/restaurants/[slug]/accounting/reports/vat-return`,
  same "default to the current calendar month if `fromDate`/`toDate` are
  missing or invalid" convention as every other report route in this
  module. Gated on `MANAGE_ACCOUNTING`, same as Trial Balance/P&L/Balance
  Sheet/Cash Flow/Aging.
- **`AccountingBoard.tsx`** — new "VAT Return" tab under Reports, showing
  Output VAT, Input VAT, and the net payable/refundable figure, with the
  "reference summary, not a filable form" note and the refund-exclusion
  caveat both visible on screen.

## Verification

- `tsc --noEmit`: clean.
- `eslint`: 0 errors across every file this slice touched.
- `vitest run` (targeted + full suite): **1601 passed** (1597 baseline + 4
  new, all in `accounting-vat-return.test.ts`): a period with both a VAT
  sale and a VAT-inclusive purchase nets to the correct payable figure; a
  period with only a VAT-inclusive purchase (no offsetting sale) reports
  the correct net-refundable figure; activity outside the requested period
  is excluded; a purchase with no VAT entered contributes nothing to Input
  VAT. The same 8 pre-existing, unrelated failures from before this slice
  (eSewa callback port mismatch, branch-filtering push-notification test,
  missing `GROQ_API_KEY`) are untouched.
- `npm run build`: succeeds; the new route appears in the route manifest.
- Dev server smoke test: the new GET route returns a clean `401`
  unauthenticated, identical to every other report route's own behavior.

## Up next

Per the plan's own Part 5, #3: **6b (effective-dated tax rates)** and **6d
(credit/debit notes)** remain independent of each other and can come in
either order, but both still need their own sign-off — 6b on open decision
#1 (does its `tax_rates` table replace or layer on `taxRateBasisPoints`),
and the "serves alcohol/has a bar" flag (#2) is a separate, still-open
question unrelated to either. **6e (Nepal tax depreciation)** can be built
anytime — it has the least code-reuse with the rest of Phase 6.
