# Accounting Module — Phase 4, Slice 4d Completion Report

Status: **Slice 4d complete** (expense payments, automatically posted) —
the fourth of Phase 4's automatic integrations, per
`ACCOUNTING_PHASE_4_PLAN.md`. Required resolving one genuine gap the plan
only flagged for verification (below), otherwise built to spec.

## What was built

**Expense posting** (`postExpenseVoucher`, wired into the expenses create
route for a direct-pay expense, and into the `pay` route for the two-step
approve-then-pay flow — both are the only two moments an expense actually
becomes "paid"). Per `ACCOUNTING_POLICY_AND_POSTING_MATRIX.md` §5: Dr the
expense category's own account, Cr the clearing account mapped to the
payment method actually used.

**Category account auto-provisioning**
(`resolveOrProvisionExpenseCategoryAccount`). Expense categories are
free-text, restaurant-defined data, not a fixed seed list like the rest of
the chart of accounts — so there's no way to pre-map them. The first time
a given category is ever paid, this creates its own expense account (named
after the category, coded from a reserved 5200+ block, incrementing by 10)
and its mapping row in the same transaction, then reuses it on every
subsequent payment. Both inserts use `onConflictDoNothing` rather than a
try/catch: a caught unique-violation on an in-flight transaction with no
savepoint would poison the whole transaction, silently failing the
voucher post that comes right after it. The calling route logs a
`accounting.account_auto_created` audit entry once the transaction has
actually committed, matching this codebase's existing convention that
audit logs always fire post-commit through the top-level `db` handle.

**The payment-method mapping gap (resolved via `AskUserQuestion`, not
assumed):** the plan flagged that `EXPENSE_PAYMENT_METHODS` (cash,
bank_transfer, esewa, khalti, mobile_banking, other) needed verification
against the existing `PAYMENT_METHOD_*` mapping keys before assuming a
1:1 fit. Verification showed a real mismatch — those four keys are shaped
for POS sales (cash/card/mobile_wallet/other), "card" doesn't apply to
money going *out* at all, and bank_transfer/esewa/khalti/mobile_banking
had no matching account. You chose the recommended option: cash and
"other" reuse the existing `PAYMENT_METHOD_CASH`/`PAYMENT_METHOD_OTHER`
accounts (same physical till/bucket either flow uses), and the other four
methods share one new account, **"Bank / Digital Payments"** (new seed
account, code 1040) — since nothing today reconciles or distinguishes
between them, and it's easy to split apart once Phase 5 adds real Bank
Accounts.

**Void/un-void as one reversal-chain function**
(`reverseOrRestoreExpenseVoucher`, wired into the `PATCH .../[expenseId]`
route's existing `togglingVoid` block, called identically in both
directions). Voiding a paid expense needs to reverse its voucher exactly
like every other void path in this module. Un-voiding is the new case:
simply re-posting a fresh "paid" voucher (mirroring how
`recordExpenseLedgerEntry` re-inserts a fresh ledger row) doesn't work,
because `sourceType`/`sourceId`/`postingEvent` would collide with the
already-reversed original and `postVoucher`'s own idempotency check would
just hand back that stale voucher — posting nothing new, silently
under-counting the restored expense. Instead this function always walks
the `reversalOfVoucherId` chain from the expense's original "paid"
voucher to whichever voucher in the chain is currently *not* itself
reversed, and reverses that one. Reversing a reversal flips its swapped
lines back to the original direction, so voiding then un-voiding nets
back to exactly the original posting — and the same function handles any
number of further void/un-void cycles without special-casing which
"round" it's on. A no-op if no voucher was ever posted for the expense
(automatic posting wasn't on when it was originally paid).

**A restaurant-wide-expense branch-tagging default**, reused from Slice
4c: an expense with no `branchId` (restaurant-wide) still needs exactly
one branch tag on its voucher, so both the create and pay routes fall
back to the restaurant's main branch — the same pragmatic default already
applied to Slice 4c's lump-sum settlements, for the same reason (the data
model has no single "right" branch for a restaurant-wide event).

## A TypeScript bug found and fixed along the way

Both routes originally declared
`let autoProvisionedAccount: AutoProvisionedAccount | null = null;`
*outside* the `db.transaction()` call and assigned to it from inside the
transaction's closure. TypeScript's control-flow narrowing doesn't follow
a mutation made inside a closure back out to the outer scope reliably
across an `await` boundary here, and narrowed the variable's type to
`never` at its later `if (autoProvisionedAccount) { ...autoProvisionedAccount.id }`
usage, producing `TS2339: Property 'id' does not exist on type 'never'`.
Fixed by having the `db.transaction()` callback itself `return { row,
autoProvisioned }` and destructuring the result after the `await`,
instead of mutating an outer variable — confirmed clean on a subsequent
`tsc --noEmit` run.

## Verification

- 6 new integration tests (`accounting-integration-expenses.test.ts`): a
  cash expense (auto-provisioning its category's account on first use,
  reusing it on the second), bank_transfer/eSewa/Khalti/mobile_banking all
  sharing the Bank / Digital Payments account, an "other" expense posting
  against Other Clearing, void-then-un-void netting back to zero across
  the full reversal chain, idempotent replay, and auto-provisioned
  accounts landing in the reserved 5200+ block without colliding with the
  fixed seed. All 6 passing on the first run.
- One pre-existing test needed updating, not fixing: adding the new
  seed account (code 1040) bumped the chart-of-accounts seed count from
  22 to 23, and `accounting-posting.test.ts` hardcoded the old count
  (23 total, including its own inactive test fixture). Updated to 24.
  This is an expected consequence of adding a seed account, not a
  regression.
- Full suite: 1546 passed (up from 1540 — the 6 new tests), same 8
  pre-existing environment-only failures as every prior phase and slice
  (missing `GROQ_API_KEY`, dev `PORT` mismatch, push-branch-filtering) —
  confirmed unrelated, not a regression.
- `tsc --noEmit`, `eslint .`, `npm run build`: all clean.
- Live dev-server smoke test: all three changed/new routes (expense
  create, expense pay, expense PATCH/void) return a clean 401 for an
  unauthenticated request with a valid `x-restromitra-client` header (no
  500s). Dev server stopped cleanly afterward; port 3000 confirmed free.

## What Slice 4d deliberately does NOT do

No splitting the shared Bank / Digital Payments account into per-method
accounts (deferred until Phase 5 adds real Bank Accounts, per the
sign-off above). No payroll or reconciliation postings (Slices 4e/4f,
still ahead). No change to how expense approval (`pending_approval` →
`approved`) works — that stage still has no ledger or accounting effect,
matching the existing "never book money as spent before someone with PAY
authority confirms it actually went out" rule.

## Next step

Slice 4e — payroll (cash-basis) — per `ACCOUNTING_PHASE_4_PLAN.md`. Not
started; awaiting confirmation to proceed.
