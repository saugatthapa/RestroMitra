# Accounting Module — Phase 4, Slice 4e Completion Report

Status: **Slice 4e complete** (payroll payouts, cash-basis, automatically
posted) — the fifth of Phase 4's automatic integrations, per
`ACCOUNTING_PHASE_4_PLAN.md`. Corrected one factual error in the plan's
own open-decisions list (below) rather than following it as written,
otherwise built to spec.

## What was built

**Payroll posting** (`postPayrollVoucher`, wired into the payroll
payments create route right after the existing `recordPayrollLedgerEntry`
call — payroll has no approve-then-pay two-step the way expenses does, so
there's only one call site for creation). Per
`ACCOUNTING_POLICY_AND_POSTING_MATRIX.md` §6, cash-basis: Dr Salary
Expense, Cr the clearing account mapped to the payment method actually
used, for the full payout amount.

**A correction to the plan's own Part 5 #6, found while implementing, not
assumed:** the plan says "no payment-method field on a payroll payment
either — default everything to Cash on Hand," treating it as the same gap
as purchases' and reasoning by analogy. Checking the actual schema showed
this is wrong: `payrollPayments.paymentMethod` is `NOT NULL` and typed
`expensePaymentMethodEnum` — the identical six-value
cash/bank_transfer/esewa/khalti/mobile_banking/other set expenses use.
`expense-payment-methods.ts`'s own doc comment confirms this isn't a
coincidence: the underlying catalog moved to a shared `payout-methods.ts`
specifically *because* payroll needed the same set expenses already had.
Given that, this slice reuses the exact mapping built and signed off on
in Slice 4d (`PAYOUT_METHOD_MAPPING_KEYS`, exported from
`integrations/expenses.ts` rather than duplicated) instead of defaulting
every payout to Cash on Hand — the same shared "Bank / Digital Payments"
account applies here for the identical reason (nothing today reconciles
between bank_transfer/esewa/khalti/mobile_banking), under the sign-off
you already gave for expenses, not a fresh decision needing its own ask.

**Salary Expense and Salary Payable are already fixed seed accounts**
(codes 5100/2300, both present since Phase 1's seed data) — unlike
expense categories, there's no dynamic/user-created account to
auto-provision here. Salary Payable exists in the seed but is
deliberately unused by this slice; it's reserved for the accrual-basis
alternative the matrix and plan both flag as a legitimate future option,
not something cash-basis posting needs to touch.

**Void reversal** (`reversePayrollVoucher`, wired into the payroll
payment void route right after the existing `reversePayrollLedgerEntry`
call). Unlike expenses, a payroll void is **one-way** — the
`[paymentId]` PATCH route only ever sets `isVoided: true`; there is no
un-void endpoint — so this is a single, plain `reverseVoucher()` call
against the original "paid" voucher, the same shape as Slice 4c's
`reversePurchaseVoucher`, not the reversal-chain walk expenses' two-way
toggle needed.

**Cash-basis confirmed, per Part 5 #7** — matches the plan's own
recommendation and today's only actual behavior (no accrual trigger
exists anywhere in this codebase to post against instead).

**The name-redaction discipline verified end-to-end.** Per the plan's own
call-out: `recordPayrollLedgerEntry`'s narration is already generic
("Staff salary payment — <period label>"), never a staff name, because
`MANAGE_ACCOUNT_BOOKS`/`MANAGE_ACCOUNTING` are deliberately not paired
with `VIEW_PAYROLL`. `postPayrollVoucher`'s own narration mirrors that
string exactly (same fallback for a null period label), and a dedicated
test posts a payment whose `staffNameSnapshot` is a distinctive full name
and asserts the voucher's narration is exactly the generic string and
does not contain that name anywhere.

**A restaurant-wide-staff branch-tagging default**, reused from Slices
4c/4d: a staff member with no `branchId` still needs exactly one branch
tag on their payout voucher, so the create route falls back to the
restaurant's main branch — same pragmatic default, same reasoning, third
time it's been needed.

## Verification

- 6 new integration tests (`accounting-integration-payroll.test.ts`): a
  cash payout (Dr Salary Expense / Cr Cash on Hand), the narration never
  containing the staff member's name, bank_transfer/eSewa/Khalti/mobile
  banking all sharing the Bank / Digital Payments account, an "other"
  payout posting against Other Clearing, a void fully reversing the
  voucher (and a second void attempt correctly throwing "already been
  reversed" rather than silently no-op'ing or double-reversing), and
  idempotent replay. All 6 passing on the first run.
- Full suite: 1552 passed (up from 1546 — the 6 new tests), same 8
  pre-existing environment-only failures as every prior phase and slice
  (missing `GROQ_API_KEY`, dev `PORT` mismatch, push-branch-filtering) —
  confirmed unrelated, not a regression.
- `tsc --noEmit`, `eslint .`, `npm run build`: all clean.
- Live dev-server smoke test: both changed routes (payroll payment
  create, payroll payment void) return a clean 401 for an unauthenticated
  request with a valid `x-restromitra-client` header (no 500s). Dev
  server stopped cleanly afterward; port 3000 confirmed free.

## What Slice 4e deliberately does NOT do

No accrual-basis payroll (Salary Payable stays an unused seed account for
now, per the plan's own cash-basis recommendation). No splitting the
shared Bank / Digital Payments account into per-method accounts (same
Phase-5-deferred reasoning as Slice 4d). No reconciliation postings
(Slice 4f, still ahead).

## Next step

Slice 4f — reconciliation → bank settlement — per
`ACCOUNTING_PHASE_4_PLAN.md`. The plan itself flags this one as depending
on a minimal Bank Account existing (pulled forward from Phase 5) before
it can post at all — not started; awaiting your direction on whether to
pull that minimal piece forward now or hold Slice 4f until Phase 5
proper.
