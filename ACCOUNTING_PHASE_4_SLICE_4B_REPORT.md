# Accounting Module — Phase 4, Slice 4b Completion Report

Status: **Slice 4b complete** (Accounts Receivable settlement + refunds,
automatically posted) — the second of Phase 4's automatic integrations, per
`ACCOUNTING_PHASE_4_PLAN.md`. Built on the opt-in gate and account-mapping
resolver Slice 4a already put in place; no new cross-cutting mechanics were
needed.

## What was built

**Payment settlement**
(`src/lib/accounting/integrations/payment-settlement.ts`,
`postPaymentSettlementVoucher()`), wired into the payments route right after
the existing order/payment-status update, gated on both
`order.status === "completed"` and `isAutomaticPostingEnabled()`. Per
`ACCOUNTING_POLICY_AND_POSTING_MATRIX.md` §2: an order's full revenue is
recognized once, at completion (Slice 4a's Sales Voucher) — so a payment
recorded against an order that's *already* completed isn't new revenue,
it's the customer paying down the Accounts Receivable balance Slice 4a
left behind. A payment recorded *before* completion posts nothing here; it's
simply one of the rows Slice 4a's own Sales Voucher sums up once the order
completes.

- Debits the payment method's clearing account for bill + tip together (same
  "the till physically receives it" reasoning Slice 4a established).
- Credits Accounts Receivable for the bill portion, Tips Payable for the tip
  portion — split cleanly since a settlement's tip is real, freshly-recorded
  data, not something being inferred after the fact.
- An edge case (tipping with no remaining balance due) still posts correctly:
  if the bill portion is zero, only the tip lines post, straight to Tips
  Payable.

**Refunds** (`postRefundVoucher()`), wired into the refunds route right
after the existing order/payment-status update. Gated only on
`isAutomaticPostingEnabled()` — unlike settlement, a refund posts regardless
of the order's current status, since reversing already-recognized revenue
can legitimately happen well after an order completed (or was later
cancelled).

- Books the full refund amount to Sales Returns & Refunds, credited from the
  original payment method's clearing account.
- Per the plan's own documented decision (Part 5, open decision on
  tip-refund splitting): the full amount goes to Sales Returns & Refunds with
  no attempt to carve out a tip portion, because the `payments` schema has no
  field distinguishing "of this refund, this much was tip" — splitting would
  mean guessing, not reading real data. This is a known limitation, not an
  oversight; revisit if the schema ever gains that field.
- Dated to *today* (via `restaurantDate()`), never backdated to the
  original sale — a refund is its own event, not a correction to a past
  voucher.

Both reuse Slice 4a's `resolveAccountMappings()` and idempotency pattern
(`sourceType`/`sourceId`/`postingEvent`), and both pass
`allowClosedPeriod: true` unconditionally, consistent with Slice 4a.

## Verification

- 5 new integration tests (`accounting-integration-settlement.test.ts`)
  against real order/payment fixtures: a fully-on-credit order settled by a
  later cash payment (proving net Accounts Receivable across both vouchers
  returns to zero), a settlement payment carrying a tip (proving the AR/Tips
  Payable split), a same-day cash refund, a refund against a previous day's
  order (proving today's date is used, not the original sale date), and
  idempotent replay of both settlement and refund. All 5 passing after one
  fixture fix (the test's `makeCompletedOrder` helper was missing the
  NOT NULL `tax_in_paisa` column on the `orders` insert — same category of
  bug as Slice 4a's test fixtures, caught the same way, by running the tests
  against the real schema rather than assuming the insert was complete).
- Full suite: 1532 passed (up from 1527 — the 5 new tests), same 8
  pre-existing environment-only failures as every prior phase and slice
  (missing `GROQ_API_KEY`, dev `PORT` mismatch) — confirmed unrelated, not a
  regression.
- `tsc --noEmit`, `eslint .`, `npm run build`: all clean.
- Live dev-server smoke test: the changed payments and refunds routes both
  return a clean 401 for an unauthenticated request with a valid
  `x-restromitra-client` header (no 500s) — confirming the new wiring is
  correct end to end, not just type-checked. Dev server stopped cleanly
  afterward; port 3000 confirmed free.

## What Slice 4b deliberately does NOT do

No splitting of a refund's tip portion from its bill portion (documented
limitation above, per the approved plan). No purchases/expenses/payroll/
reconciliation postings (Slices 4c–4f, still ahead). No handling of combined
"pay for multiple orders in one payment" flows — the payments route posts
per-order, per-payment, which matches how the schema itself records
payments today.

## Next step

Slice 4c — purchases + supplier payment settlement — per
`ACCOUNTING_PHASE_4_PLAN.md`. Not started; awaiting confirmation to proceed.
