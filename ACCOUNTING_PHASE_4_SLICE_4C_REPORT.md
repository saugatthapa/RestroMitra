# Accounting Module — Phase 4, Slice 4c Completion Report

Status: **Slice 4c complete** (purchases + supplier/customer due settlement,
automatically posted) — the third of Phase 4's automatic integrations, per
`ACCOUNTING_PHASE_4_PLAN.md`. Wider than the plan's own Slice 4c write-up in
one respect (purchase-void reversal, explained below), otherwise built
exactly to spec.

## What was built

**Purchase posting** (`postPurchaseVoucher`, wired into the purchases
route right after the existing `recordPurchaseLedgerEntry` call). Per
`ACCOUNTING_POLICY_AND_POSTING_MATRIX.md` §4: Dr Inventory for the
purchase's total, Cr Accounts Payable (tagged the supplier, when there is
one) for a credit purchase, or Cr Cash on Hand for an immediate one.

**Open decision #5, applied as approved:** an immediate purchase has no
payment-method field at all — only `isCredit` — so there's no way to know
whether it was paid from the till or by bank transfer. Every immediate
purchase defaults to Cash on Hand, per the plan's own recommendation,
until a real payment-method field exists alongside Bank Accounts (Phase 5).

**Purchase void reversal** (`reversePurchaseVoucher`, wired into the
purchase-void route) — **not explicitly called out in the plan's own Slice
4c section**, which only described posting a purchase, not un-posting one.
Found while implementing: `voidPurchase()` already reverses the purchase's
stock movement and its linked Account Books ledger due (see its own doc
comment in `supplier-dues.ts`) — leaving this new voucher standing after a
void would permanently overstate Inventory and Accounts Payable/Cash, with
no way back short of a manual Journal Voucher. Closed it the same way
Slices 4d/4e's own (not-yet-built) void paths are specified to: a full
`reverseVoucher()` call, safe unconditionally here because `voidPurchase()`
already refuses to void a purchase once any payment has been recorded
against it — so there is never a partial-settlement case to reconcile.

**The generic single-entry due settlement**
(`postLedgerDueSettlementVoucher`, wired into
`.../ledger/[entryId]/settle/route.ts`). This route is Account Books'
one generic "on credit, settle" mechanism, used for both a supplier due
(`referenceType: "purchase"`) and a customer/order due
(`referenceType: "order"`) — so this posts whichever mirror applies: Dr
Accounts Payable / Cr Cash for a supplier due, or Dr Cash / Cr Accounts
Receivable for a customer due. Every other ledger-entry category never
reaches `dueStatus: "outstanding"` in the first place, so a third
`referenceType` is a safe no-op rather than a thrown error.

**Lump-sum settlements** (`postSupplierPaymentVoucher` for
`.../suppliers/[supplierId]/payments/route.ts`,
`postCustomerCreditSettlementVoucher` for
`.../customers/[customerId]/credit/settle/route.ts`). Both routes can
settle several underlying purchases/orders' dues in one call
(oldest-first allocation) — per the plan's own note, the accounting mirror
is **one voucher for the total amount actually applied**, not one per
underlying ledger entry, since AP/AR tracking in this module comes from
`accounting_voucher_lines`' own `supplier_id`/`customer_id` tags, not from
mirroring `ledger_entries`' row shape one-to-one.

**A branch-tagging decision not covered by the plan's text:** a lump-sum
payment can settle purchases/orders recorded at *different* branches, but
every voucher needs exactly one `branchId`. Tagged to the restaurant's
main branch — the same kind of pragmatic default the plan already applies
to the two payment-method gaps (decisions #5/#6), for the same underlying
reason: the data model has no single "right" answer, and a restaurant-wide
financial event needs *some* branch tag regardless. The single-entry
settle route doesn't have this problem — it looks the branch up from the
one purchase/order the entry actually references.

**`recordSupplierAdjustment` remains un-integrated**, exactly as the plan
recommended deferring to Phase 5 (it never sets `markAsDue`, so it can
never reach the settlement paths above either).

## Verification

- 8 new integration tests
  (`accounting-integration-purchases.test.ts`): a cash purchase, a credit
  purchase (tagged to the supplier), a purchase void (proving the
  reversal nets Inventory/Accounts Payable back to zero), the generic
  single-entry settle route for both a supplier due and a customer/order
  due, a lump-sum supplier payment across two purchases, a lump-sum
  customer credit settlement, and idempotent replay. All 8 passing.
- Full suite: 1540 passed (up from 1532 — the 8 new tests), same 8
  pre-existing environment-only failures as every prior phase and slice
  (missing `GROQ_API_KEY`, dev `PORT` mismatch) — confirmed unrelated, not
  a regression.
- `tsc --noEmit`, `eslint .`, `npm run build`: all clean.
- Live dev-server smoke test: all five changed/new routes (purchases
  create, purchase void, generic ledger settle, supplier payment,
  customer credit settle) return a clean 401 for an unauthenticated
  request with a valid `x-restromitra-client` header (no 500s). Dev
  server stopped cleanly afterward; port 3000 confirmed free.

## What Slice 4c deliberately does NOT do

No `recordSupplierAdjustment` integration (deferred to Phase 5, per the
plan). No splitting a lump-sum payment into per-branch vouchers when it
spans branches (tagged to the main branch instead — see above). No
expenses/payroll/reconciliation postings (Slices 4d–4f, still ahead).

## Next step

Slice 4d — expenses — per `ACCOUNTING_PHASE_4_PLAN.md`. Not started;
awaiting confirmation to proceed.
