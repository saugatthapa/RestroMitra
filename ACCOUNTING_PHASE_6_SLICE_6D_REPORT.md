# Accounting Phase 6, Slice 6d — Credit/Debit Notes (Sales Refunds)

## What was built

Slice 6d closes the gap Slice 6c's own VAT return report flagged: a sales
refund previously reduced only the cash/AR side of the books (via the
existing `postRefundVoucher`), never the Output VAT ("2100 Tax Payable")
account. A refund on a taxed order now:

1. **Reduces Output VAT correctly.** `postRefundVoucher` splits the refund
   amount into a goods portion (still debited to "Sales Returns & Refunds")
   and a tax portion (debited to "Tax Payable"), so a refund of a taxed sale
   now reverses that sale's own tax liability, not just its revenue.
2. **Gets a formal, gapless, sequential credit-note number**, mirroring the
   existing fiscal-invoice numbering scheme — the fiscal document trail a
   VAT-compliant credit note needs, independent of the bookkeeping voucher
   itself.

Per the plan's own wording in `ACCOUNTING_PHASE_6_PLAN.md` Part 3 ("a
dedicated voucher shape... distinct from Slice 4a's existing cash refund
voucher, which handles the cash-flow side but not a VAT-compliant credit
note's own paper trail"), this was implemented as an **enhancement of the
existing refund voucher and route**, not a new voucher type or a parallel
document-creation flow — see "One voucher type per business-event
category," a convention this engagement has held since Phase 4.

## The design fork, and how it was resolved

The refunds feature only ever stores a lump-sum amount against an order —
there is no line-item link tying a partial refund to specific menu items.
For a full refund, or for an order where every item shares one tax rate,
the tax portion of the refund is unambiguous. For a **partial** refund of
an order that genuinely mixes taxable and tax-exempt items, the existing
data does not uniquely determine how much of that partial refund was tax
versus goods — no formula can recover information the system never
recorded.

This was surfaced to the user via `AskUserQuestion` rather than guessed.
The user selected **"Prorate automatically (Recommended)"**:

```
taxPortionInPaisa = round(amountInPaisa × orderTaxInPaisa / orderTotalInPaisa)
```

using the ORIGINAL order's own recorded `taxInPaisa`/`totalInPaisa` (not
however much of the order has already been refunded before). This is
**exact** for a full-order refund or any order where every item shares one
flat tax rate — the common case for a flat-VAT restaurant menu — and an
**approximation** only for a partial refund of an order that genuinely
mixes tax rates. There is no per-item link on a refund today to do better
than that; a future slice could close this fully only by adding item-level
refund tracking, which is out of scope here.

## What changed, file by file

- **`src/db/schema.ts`** — added `fiscalCreditNoteNumber` and
  `fiscalCreditNoteAssignedAt` to `payments`, with a partial unique index
  scoping the number to `(restaurantId, fiscalCreditNoteNumber)` only where
  non-null. Added a new `fiscal_credit_note_counters` table — a separate
  table from the existing `fiscal_invoice_counters`, so a credit note is
  its own independent fiscal-document sequence, never sharing numbers with
  or perturbing the already-shipped invoice sequence.
- **`src/lib/fiscal-invoice.ts`** — added `assignFiscalCreditNoteNumber`,
  mirroring `assignFiscalInvoiceNumber`'s existing pattern exactly:
  gapless, strictly increasing per restaurant, assigned via an atomic
  `INSERT ... ON CONFLICT DO UPDATE SET last_number = last_number + 1`, and
  idempotent — calling it again for a payment that already has a number
  returns that same number without advancing the counter.
- **`src/lib/accounting/integrations/payment-settlement.ts`** —
  `postRefundVoucher` now takes the original order's own `orderTaxInPaisa`
  and `orderTotalInPaisa`, computes the prorated tax portion described
  above, and posts a conditional third line (goods portion only when
  positive, tax portion only when positive, full amount always credited to
  the payment-method account) — a tax-free order (`orderTaxInPaisa === 0`)
  reduces to exactly the pre-6d behavior of booking the full amount to
  Sales Returns & Refunds.
- **`src/app/api/restaurants/[slug]/orders/[orderId]/refunds/route.ts`** —
  passes the order's own `taxInPaisa`/`totalInPaisa` into `postRefundVoucher`,
  and — only when the order actually charged tax — assigns a fiscal credit
  note number via `assignFiscalCreditNoteNumber` inside the same
  transaction, independent of whether automatic accounting posting is even
  turned on for the restaurant (a compliance/paper-trail concern, not a
  bookkeeping one).
- **`src/app/dashboard/orders/[orderId]/OrderBillView.tsx`** — the payment
  history now shows `· Credit Note #N` next to a refund that was assigned
  one. `BillReceiptView.tsx` was checked and has no payment/refund display
  at all, so it needed no change — this slice does not add a separate
  printable credit-note document; that would be a natural follow-up but is
  out of scope here.
- **`src/lib/accounting/vat-return.ts`** and
  **`src/app/dashboard/accounting/AccountingBoard.tsx`** — updated the
  Slice 6c "known limitation" comment and the on-screen VAT Return caveat
  text to describe the gap as now partial (exact for full refunds/flat-rate
  orders, an estimate only for a partial refund of a genuinely mixed-rate
  order) rather than total, since it's now false that refunds never touch
  Output VAT.
- **`drizzle/0088_last_marrow.sql`** — the new table, columns, and unique
  indexes described above. Applied cleanly.
- **Tests**: extended
  `src/db/__tests__/accounting-integration-settlement.test.ts` with 3 new
  cases (full refund of a taxed order reduces Tax Payable by exactly the
  order's own tax; a partial refund prorates the tax portion; a refund of a
  tax-free order is unaffected) and added `src/db/__tests__/fiscal-credit-note-concurrency.test.ts`,
  mirroring the existing `fiscal-invoice-concurrency.test.ts` coverage:
  concurrent assignment produces a gapless/contiguous/non-duplicate set of
  numbers, re-calling is idempotent, and the credit-note sequence shares no
  counter with the fiscal invoice sequence.

## A test-setup bug found and fixed along the way

While writing the two new taxed-order tests, the shared `makeCompletedOrder`
test helper turned out to set `subtotalInPaisa` unconditionally equal to
`totalInPaisa`, which is only correct when `taxInPaisa` is zero (the only
case every pre-existing caller used). This made the underlying SALE voucher
itself imbalanced whenever a test passed a non-zero `taxInPaisa`, throwing
from `postSaleAndCogsVouchers` before the refund logic under test was even
reached. Fixed by computing `subtotalInPaisa: params.totalInPaisa -
(params.taxInPaisa ?? 0)` — a test-data fix only, no production code
involved.

## Verification

- `npx tsc --noEmit` — clean.
- `npx eslint` on every touched file — clean.
- Targeted tests (`accounting-integration-settlement.test.ts`,
  `fiscal-credit-note-concurrency.test.ts`, `fiscal-invoice-concurrency.test.ts`,
  `accounting-vat-return.test.ts`) — 18/18 passing.
- Full `npx vitest run` — 1607/1615 passing. The 8 failures are pre-existing
  and unrelated to this slice: `push-branch-filtering.test.ts` (known
  environment flakiness in branch-scoped push delivery, unrelated to
  accounting) and `route.test.ts` for the payment-gateway callback (a
  hardcoded port-mismatch in the test's own expected redirect URL,
  pre-existing). None of the 8 touch accounting code.
- `npm run build` — succeeds cleanly.
- Dev-server smoke test on `/api/restaurants/[slug]/orders/[orderId]/refunds`:
  unauthenticated `GET` returns a clean `405` (the route only defines
  `POST`), unauthenticated `POST` returns a clean `400` — no crash, no stack
  trace leak.

## Deliberately out of scope

- **Purchase-side debit notes.** This slice covers sales-side refunds of
  already-collected payments only. There is no existing purchase-return
  feature to extend, and building one from scratch was judged a separate,
  larger feature than "enhance the existing refund voucher."
- **Price adjustments on unpaid/uncollected orders.** A different existing
  feature (editing an order before payment) already covers this case; it
  never touches a refund voucher.
- **A separate printable credit-note document.** `OrderBillView.tsx` now
  surfaces the credit-note number inline in payment history; no standalone
  printable credit-note page/PDF was built.
- **Full per-item tax accuracy on partial refunds of mixed-rate orders.**
  Per the sign-off above, this remains a documented approximation — closing
  it fully would require item-level refund tracking, a larger schema
  change than this slice's scope.
- **Nepal-specific IRD filing compliance.** As with Slice 6c, this is a
  reference improvement to the restaurant's own books, not a claim that the
  resulting credit-note numbering or VAT treatment satisfies any specific
  IRD filing requirement — that has not been verified and is not asserted
  here.

## What's next

Per `ACCOUNTING_PHASE_6_PLAN.md` Part 5 #3, the remaining Phase 6 slices are
6b (effective-dated tax rates — blocked on an open decision about whether to
replace or layer on the existing `taxRateBasisPoints`) and 6e (Nepal tax
depreciation, pooled declining-balance) — neither has a plan-stated required
order relative to the other, and both will need either further sign-off
(6b) or research-then-possibly-ask (6e) when picked up.
