# Accounting Phase 6, Slice 6a — Input VAT Tracking on Purchases

## What this slice builds

The first slice of `ACCOUNTING_PHASE_6_PLAN.md`, per that plan's own
recommended, decision-independent starting point (Part 5, #3): a restaurant
can now record that a supplier's invoice included VAT, and that VAT gets a
real, correct home in the ledger — a new **"1150 Input VAT Receivable"**
asset account, rather than silently being folded into Inventory cost the
way every purchase was booked before this slice.

## The one real design decision, and how it was resolved

Before writing any code, reading `integrations/purchases.ts` surfaced a
genuine accounting-policy fork the plan's own high-level text hadn't
anticipated: a purchase's line-item unit costs feed **both** the accounting
Inventory debit **and** the app's own inventory weighted-average costing
(`applyPurchaseCosting`) — the same number, used twice. So when an invoice
includes VAT, should the entered VAT amount be additional to those unit
costs, or already baked into them? Put to you directly, since it changes
what "correct" means for two different parts of the system at once — you
chose **additive**, confirmed by sign-off:

- The line items' own total (`totalInPaisa`) is untouched — still exactly
  what it always was, and still exactly what Inventory is debited for and
  what the app's own per-item costing uses. Nothing about an existing
  purchase's inventory valuation changes by this slice existing.
- VAT is a genuinely new, separate amount **on top of** that total — the
  real amount owed to the supplier is `totalInPaisa + vatInPaisa`, matching
  how a real invoice actually reads (goods price + VAT = amount due).
- This avoids the alternative's real cost: carving VAT out of the existing
  total would have left the accounting Inventory account permanently
  understated relative to the app's own inventory valuation, with no
  explanation anywhere in the UI for why the two never reconcile.

## What changed

- **`account-mapping-keys.ts`** — new `MAPPING_KEYS.INPUT_VAT` key.
- **`chart-of-accounts.ts`** — new seeded account, fixed at **1150** (between
  Accounts Receivable and Inventory — neither reserves a code block of its
  own to collide with, unlike 1051-1099/1901-1999/2401-2499/5200+).
- **`purchases` table** — one new nullable column, `vatInPaisa`
  (`purchases_vat_non_negative` CHECK: null or ≥ 0). Null (not zero) means
  "no VAT entered," the same as every purchase before this slice.
  `totalInPaisa`'s own meaning is completely unchanged.
- **`integrations/purchases.ts`** — `postPurchaseVoucher` gains an optional
  `vatInPaisa` param. When positive, the voucher gains a third line (Dr
  "1150 Input VAT Receivable") and the Accounts Payable/Cash line is
  credited for `totalInPaisa + vatInPaisa`, not `totalInPaisa` alone — the
  Inventory line itself is untouched. The voucher still balances by
  construction, the same optional-line pattern Slice 5e's interest line and
  Slice 5d's disposal gain/loss line already established.
- **`purchases` route** — passes the entered VAT through to the purchase
  row, and (crucially) passes `totalInPaisa + vatInPaisa` — the TRUE amount
  owed — into `recordPurchaseLedgerEntry`, so Account Books' own supplier
  due-tracking and Supplier Statement reflect the real invoice total, not
  just the goods figure. `voidPurchase`/`reversePurchaseVoucher` needed no
  changes: both already operate on whatever amount was actually recorded
  (the ledger entry row, and the voucher's own lines), not a recomputation
  from `totalInPaisa`.
- **`purchases/export` route** — a new "VAT (Rs)" CSV column, additive to
  "Total (Rs)", so the export doesn't silently drift from what Account
  Books now tracks as outstanding.
- **`validation/inventory.ts`** — `createPurchaseSchema` gains an optional
  `vatAmount` (reuses the existing `rupeeAmount` schema — positive only;
  omit the field entirely for "no VAT," the same "never zero" convention
  the column itself uses).
- **Inventory UI** — an optional "VAT charged by supplier" field on the
  purchase form (explicitly labeled "added on top of the line items
  below"), and the purchase list now shows `Total: X + VAT Y = Z` whenever
  VAT was entered, so the displayed total and the due/outstanding amount
  the same card shows never disagree.

## What this slice deliberately does not touch

- **Inventory costing itself** (`applyPurchaseCosting`) — per the sign-off
  above, out of scope by design. A restaurant's own per-item weighted
  average cost still includes whatever the staff typed as "cost per unit,"
  same as before.
- **The purchases table's own `totalInPaisa` semantics** — still exactly
  "the denormalized sum of this purchase's line items," never
  reinterpreted to mean "everything owed."
- **A VAT return / net-payable report** — that's Slice 6c, which needs this
  slice's Input VAT balance to be real before it can net it against 2100's
  Output VAT credits. Not started here.

## Verification

- `tsc --noEmit`: clean.
- `eslint`: 0 errors across every file this slice touched.
- `vitest run` (targeted + full suite): **1597 passed** (1592 baseline + 5
  new — 3 in `accounting-integration-purchases.test.ts` covering a cash
  purchase with VAT, a credit purchase with VAT tagged to the supplier, and
  a void/reversal netting Inventory/Input VAT/Accounts Payable all back to
  zero; 2 in `validation/inventory.test.ts` covering the schema's optional
  `vatAmount` and its "no zero" rule). The same 8 pre-existing, unrelated
  failures from before this slice (eSewa callback port mismatch,
  branch-filtering push-notification test, missing `GROQ_API_KEY`) are
  untouched.
- `npm run build`: succeeds.
- Migration `0087_many_winter_soldier.sql` applied cleanly against the
  running database (`ALTER TABLE purchases ADD COLUMN vat_in_paisa` + its
  CHECK constraint).
- Dev server smoke test: GET/POST on `/api/restaurants/[slug]/purchases`
  return the same clean `401`/`400` every other route returns.

## Up next

Per `ACCOUNTING_PHASE_6_PLAN.md`'s own Part 5 #3, **6c (VAT return / tax
summary report)** is the natural next companion — it needs this slice's
Input VAT balance to produce a real net-payable figure. 6b
(effective-dated tax rates) and 6d (credit/debit notes) remain independent
and can come in either order; both still need their own sign-off per the
plan's open decisions #1 and #2. 6e (Nepal tax depreciation) can be built
anytime, least code-reuse with the rest.
