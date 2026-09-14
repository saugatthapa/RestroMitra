# Accounting Phase 5, Slice 5e — Loans

## What this slice builds

**Loans as chart-of-accounts children.** Each loan a restaurant records
(a bank term loan, a lender advance, ...) gets its own child ledger account
under the seeded "2400 Loans Payable" parent, coded in a reserved
2401–2499 block — the same wrapping pattern Slice 5b/5d already established
for bank accounts and fixed assets.

**Receipt.** "Record a loan" records the loan and posts Dr the funding
destination (cash or a real bank account, using Slice 5b's own
silent-default/picker rules) / Cr the loan's own Payable account, for the
full principal, in one transaction.

**Repayment — manual principal/interest split, no amortization
calculator.** Per sign-off (AskUserQuestion, "Recommended"): every
repayment's principal/interest split is entered by hand. The loan's own
`interestRateBasisPoints` and `termMonths` are purely informational display
data (shown next to the lender's name and stored for reference) — this
module never computes a split from them, and there is no
amortization-schedule feature anywhere in this slice. A repayment posts:

- Dr the loan's own Payable account (principal portion, if any)
- Dr Interest Expense (interest portion, if any — the line is omitted
  entirely for a principal-only payment)
- Cr Cash / Bank Account (principal + interest)

The loan's `outstandingPrincipalInPaisa` is decremented by the principal
portion only; when it reaches exactly zero the loan auto-closes
(`status: "closed"`, `closedAt` stamped) and further repayments against it
are rejected. A repayment can never take a loan's principal below zero —
overpaying beyond the outstanding balance is rejected before anything
posts.

Unlike a fixed asset's one-time acquisition/disposal, a loan repayment is
posted **without** `postVoucher`'s own `sourceType`/`sourceId` idempotency
(the same reasoning `runDepreciation` already uses in Slice 5d): a loan can
have many repayments and there's no natural one-time key available before
the voucher exists, so reusing a single source id would silently replay a
stale voucher on a second legitimate call instead of posting fresh data.

## One new seed account

- **5160 Interest Expense** — fixed at 5160, deliberately outside the
  5200+ block reserved for a restaurant's own auto-provisioned expense-
  category accounts (same reasoning as 5150 Depreciation Expense in Slice
  5d), so a growing restaurant's categories can never collide with it.

One new voucher type, `loan`, covers both a loan's receipt and every
repayment instalment, distinguished by narration — same "one type per
business-event category" convention `expense`/`fixed_asset` already
follow.

## Verification

- `tsc --noEmit`: clean.
- `eslint .`: 0 errors in every file this slice touched.
- `vitest run`: **1588 passed** (1582 baseline + 6 new, all in
  `accounting-loans.test.ts`), covering: cash-funded loan receipt (reserved
  code block, parent link, account type/normalBalance, balanced 2-line
  voucher); rejecting a non-positive principal before touching the
  database; a repayment splitting principal and interest into separate
  lines and decrementing the outstanding balance; rejecting a repayment
  whose principal exceeds the outstanding balance; auto-closing a loan when
  a repayment brings the balance to exactly zero and rejecting a further
  repayment on an already-closed loan; an interest-only repayment omitting
  the loan-payable line entirely. All pre-existing accounting integration
  tests (81 across 13 files, including every earlier slice's own) still
  pass unchanged — 14 accounting test files and 87 tests in total now that
  `accounting-loans.test.ts` is added. The same 8 pre-existing, unrelated
  failures from before this slice
  this slice (a port-mismatch in the eSewa gateway callback test, a
  branch-filtering push-notification test, and a missing `GROQ_API_KEY`
  environment variable affecting two AI-provider-config tests) are
  untouched by any file this slice changed — confirmed by running the
  `ai-provider-config-db` failures in isolation, which fail on the same
  "GROQ_API_KEY is not set" error regardless of anything in this slice.
- `npm run build`: succeeds.
- Dev server smoke test: the new GET routes return a clean `401`
  unauthenticated; the new POST routes return `400` without a CSRF header —
  identical to every other mutating accounting route's own behavior.

## What this slice deliberately does not do

- No amortization-schedule calculator or automatic principal/interest
  split — every repayment's split is a human decision, entered by hand,
  per sign-off.
- No loan covenant tracking, collateral records, or refinancing/rollover
  modeling.
- No Nepal-specific interest-deductibility or tax-treatment claim of any
  kind — `interestRateBasisPoints` and `termMonths` are purely
  informational display data.
- No partial transfer of a loan between branches — same "one loan, one
  restaurant-wide ledger account" scope fixed assets and bank accounts
  already keep.

## Up next

Per the sign-off on build order (5d → 5e → 5c): Slice 5c (Cash Flow
Statement) is last among these five slices, now that both Fixed Assets and
Loans give it real investing/financing voucher patterns to classify
against.
