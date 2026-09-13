# Accounting Module — Phase 4, Slice 4f Completion Report

Status: **Slice 4f complete, and with it Phase 4 in full** (reconciliation
→ bank settlement, automatically posted) — per
`ACCOUNTING_PHASE_4_PLAN.md`. Per your sign-off, pulled forward a minimal
Bank Account from Phase 5 rather than deferring this slice entirely.

## A clarification worth stating plainly

This slice does **not** call any bank or payment-gateway API, and doesn't
need one. The existing reconciliation feature this builds on top of is
explicitly a manual checklist (see `financial-reconciliation.ts`'s own
doc comment): a person checks their own bank/gateway statement outside
this app, then clicks "mark reconciled" here. Slice 4f only adds an
accounting voucher at that exact moment — an internal bookkeeping entry
triggered by that manual click. Nothing here requires RestroMitra to be
registered with a bank, eSewa, Khalti, or any processor.

## What was built

**A minimal Bank Account, pulled forward from Phase 5** (per your
sign-off): a new seed chart-of-accounts row (code 1045, "Bank Account")
and its own mapping key, `MAPPING_KEYS.BANK_ACCOUNT`. Deliberately
distinct from Slice 4d's "Bank / Digital Payments" (code 1040) — that one
is an *outgoing* clearing bucket for expense/payroll payouts; this one is
the *incoming* account reconciliation posts into once a payment is
confirmed to have actually landed in the bank. Phase 5 proper replaces
this single default account with real multi-bank-account support without
needing to touch this slice's posting logic.

**Reconciliation posting** (`postReconciliationVoucher`/
`reverseReconciliationVoucher`, wired into `markPaymentReconciled`/
`unmarkPaymentReconciled` — the actual choke points, per the plan's own
direction, rather than duplicated in both routes). Per
`ACCOUNTING_POLICY_AND_POSTING_MATRIX.md` §9: Dr Bank Account, Cr
whichever clearing account matches the payment's own method (Card
Clearing / Mobile Wallet Clearing / Other Clearing — the same accounts
originally debited when the sale itself was posted in Slice 4a). Cash is
structurally excluded before either function ever runs — the existing
`assertReconcilableMethod` already rejects it.

**A design wrinkle unique to this slice, reasoned through carefully:**
reconciliation can toggle — mark, unmark, re-mark, same shape as an
expense's void/un-void — but unlike every other Slice 4 integration,
`postReconciliationVoucher` has **no idempotency of its own** if called
out of turn: calling it a second time without an unmark in between would
incorrectly *reverse* an already-active voucher rather than replaying it,
because a re-mark and an unmark both reduce to the identical operation
("reverse whichever voucher in the chain is currently active"). This is
safe in practice only because `markPaymentReconciled`/
`unmarkPaymentReconciled` each gate every call behind a CAS on
`payments.reconciledAt` — a payment can only ever transition
unreconciled→reconciled or reconciled→unreconciled one step at a time,
so the accounting layer is never actually reachable "out of turn." Given
this is a real, non-obvious invariant rather than a self-evident one, a
dedicated end-to-end test (below) exercises the full mark → unmark →
re-mark cycle through the *real* `markPaymentReconciled`/
`unmarkPaymentReconciled` functions with automatic posting genuinely
enabled, not just the leaf posting functions in isolation.

**Branch and amount resolution**: `payments` has no `branchId` or a
convenient place to carry it, so `loadOwnedPayment` (already shared by
both mark and unmark) now also joins to `orders` for `branchId` and
selects `amountInPaisa` — no new query, just two more columns on the
query every reconciliation action already ran.

## Verification

- 5 new integration tests
  (`accounting-integration-reconciliation.test.ts`): card/mobile_wallet/
  other payments each routing to their own clearing account against the
  new Bank Account, an unmark fully reversing a voucher (net zero), a
  defensive check that a "cash" method is a no-op even if it somehow
  reached this module, and the full mark→unmark→re-mark cycle through the
  real `financial-reconciliation.ts` functions (with automatic posting
  actually turned on for that one test) — proving the toggle nets back to
  the original posting across exactly three vouchers, never a stray
  fourth one. All 5 passing after one self-caught bug: my first version
  of the end-to-end test queried vouchers by `sourceType`/`sourceId`,
  which only the *original* voucher carries — reversal vouchers have no
  source fields of their own (see `reverseVoucher`'s own doc comment) —
  so the test needed to walk `reversalOfVoucherId` instead, same as every
  other slice's own void/un-void tests already do. This was a test bug,
  not an application bug; the underlying posting/reversal logic was
  correct on the first run.
- One pre-existing test updated (not fixed): the new seed account bumped
  `accounting-posting.test.ts`'s hardcoded chart-of-accounts count from
  23 to 24 (25 including that test's own inactive fixture) — expected,
  same as Slice 4d's analogous update.
- Also updated the pre-existing `financial-reconciliation.test.ts`: its
  ~13 direct calls to `markPaymentReconciled`/`unmarkPaymentReconciled`
  needed the new required `timezone` (and `unmarkPaymentReconciled`'s new
  `reversedByUserId`) parameters added. That test file never enables
  automatic posting, so none of its existing assertions changed behavior
  — purely a signature update.
- Full suite: 1557 passed (up from 1552 — the 5 new tests), same 8
  pre-existing environment-only failures as every prior phase and slice
  (missing `GROQ_API_KEY`, dev `PORT` mismatch, push-branch-filtering) —
  confirmed unrelated, not a regression.
- `tsc --noEmit`, `eslint .`, `npm run build`: all clean.
- Live dev-server smoke test: both changed routes (reconciliation mark,
  reconciliation unmark) return a clean 401 for an unauthenticated
  request with a valid `x-restromitra-client` header (no 500s). Dev
  server stopped cleanly afterward; port 3000 confirmed free.

## What Slice 4f deliberately does NOT do

No real bank-API or payment-gateway integration (see the clarification
above — reconciliation stays a manual human checklist). No multi-bank-
account support (one shared default account, same Phase-5-deferred
pattern as Slice 4d's Bank / Digital Payments). No automated statement
matching.

## Where this leaves Phase 4

All six slices (4a sales+COGS, 4b payment settlement & refunds, 4c
purchases + supplier/customer settlement, 4d expenses, 4e payroll, 4f
reconciliation) are built, independently tested, and committed. Every
integration is gated behind the restaurant-level opt-in
(`automaticPostingEnabledAt`) from Part 1 of the plan, so no existing
restaurant sees any behavior change until they explicitly enable it.
Phase 4 itself is complete; anything further (accrual payroll, real
multi-bank accounts, AR/AP aging, tax engine) is explicitly Phase 5+ per
the plan's own Part 4 scope note.
