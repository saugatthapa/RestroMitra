# Accounting Phase 5, Slice 5c — Cash Flow Statement

## What this slice builds

**An indirect-method Cash Flow Statement** for a chosen period — the last
of the five Phase 5 slices, built last on purpose (per the Phase 5 plan's
own Part 5 decision #5): classifying investing and financing activity
depends on Fixed Assets (5d) and Loans (5e) existing as recognizable
voucher patterns, so building this any earlier would have meant either an
incomplete statement or a rebuild once those two landed.

No new schema — this is purely a new report over the double-entry data
every other Phase 4/5 integration already posts.

**"Cash accounts"** are the seeded 1000 (Cash on Hand), 1040 (Bank /
Digital Payments) and 1045 (Bank Account) — Slice 4d/4f's original
defaults, whether or not a restaurant has yet visited the Bank Accounts
tab that lazily wraps them into a `bank_accounts` row — union every real
bank account Slice 5b's own table lists, active or not (a since-
deactivated bank account's historical lines are still real cash movements
at the time they posted). Deliberately **not** the clearing accounts
(1010/1020/1030, Card/Mobile Wallet/Other Clearing) — those hold money not
yet actually landed in a real account, the same reasoning Slice 4f's own
reconciliation already treats them by.

**Classification is a genuine partition**, never a residual/plug that
could silently absorb a gap: every cash-touching voucher line in the
period is assigned to exactly one of Operating / Investing / Financing by
a fixed rule keyed off voucher type —

- `sales`, `purchase`, `payment`, `expense`, `refund`, `contra`, `payroll`,
  `journal` → **Operating** (a `contra` voucher, per Slice 4f, is Dr a real
  bank account / Cr a clearing account — collecting a sale, not a
  cash-to-cash transfer; this codebase posts no genuine cash-to-cash
  transfer today).
- `fixed_asset` → **Investing**, whichever direction the cash line runs
  (acquisition outflow or disposal-proceeds inflow) — and a **credit-
  funded** acquisition contributes nothing at all, correctly, since it
  never posts a cash line in the first place.
- `loan` → split within the SAME voucher: a receipt's cash line is 100%
  **Financing**; a repayment's cash line is split by its own sibling
  lines — the portion matching the loan's own Payable sub-account is
  Financing (principal), the portion matching "5160 Interest Expense" is
  **Operating** (interest) — no amortization math or lookup into the
  `loans`/`loan_payments` tables needed, since the voucher's own lines
  already carry the exact split loans.ts posted.
- `opening_balance` → excluded entirely (a one-time historical cutover,
  not a period flow — its effect is already captured in the beginning-cash
  balance, computed independently from account balances, rather than
  being double-counted as an activity line).
- `depreciation` → no rule needed; it never posts a cash line at all (Dr
  Depreciation Expense / Cr Accumulated Depreciation).

**`isReconciled`** is a genuine correctness check, not a tautology: the
statement independently computes beginning and ending cash from actual
account balances, and only reports `true` if the sum of every classified
line matches that independently-computed change exactly. A gap in the
classification ruleset above would show up here, not be hidden by it.

**Presentation**: Investing and Financing are shown as exact, direct line
items (standard practice even within an "indirect method" statement —
only Operating's own internal presentation differs between the two
methods). Operating is shown in the familiar indirect shape — Net Income,
an add-back for non-cash Depreciation, Interest paid on loans, and a
"changes in working capital and other operating activity" line — sized so
these displayed lines always sum to exactly the same, already-verified
true Operating total; the plug never masks a classification gap, it only
translates the verified total into the familiar indirect-method shape.

## Verification

- `tsc --noEmit`: clean.
- `eslint .`: 0 errors in every file this slice touched.
- `vitest run`: **1591 passed** (1588 baseline + 3 new, all in
  `accounting-cash-flow.test.ts`), covering: a full month of cash sales,
  a cash expense, a payroll payout, a cash-funded fixed asset purchase, a
  loan receipt, and a loan repayment with a principal/interest split, all
  in the same period — asserting Operating/Investing/Financing each total
  exactly the expected figure, the statement's own displayed lines sum to
  their section totals, and `isReconciled` is `true`; a credit-funded
  fixed asset acquisition contributing nothing to Investing (no cash line
  ever posted); a loan receipt with no repayment in the same period being
  entirely Financing with zero Operating interest contribution. All
  pre-existing accounting integration tests (87 across 14 files, including
  every earlier slice's own) still pass unchanged — 15 accounting test
  files and 90 tests in total now that `accounting-cash-flow.test.ts` is
  added. The same 8 pre-existing, unrelated failures from before this
  slice (a port-mismatch in the eSewa gateway callback test, a
  branch-filtering push-notification test, and a missing `GROQ_API_KEY`
  environment variable affecting two AI-provider-config tests) are
  untouched by any file this slice changed.
- `npm run build`: succeeds.
- Dev server smoke test: the new GET route returns a clean `401`
  unauthenticated, identical to every other report route's own behavior.

## What this slice deliberately does not do

- No support for a restaurant with a genuine cash-to-cash transfer voucher
  type, since none exists in this codebase today — documented explicitly
  in the code as a known scope boundary, not a silent gap (if one is ever
  added, it would need its own exclusion rule, the same way `opening_balance`
  has one now).
- No handling for an `opening_balance` voucher that touches cash and falls
  INSIDE the requested period (rather than before it, the normal case) —
  the statement will correctly report `isReconciled: false` in that case
  rather than silently misreporting, since the excluded voucher's effect
  still shows up in the independently-computed ending-cash balance. This
  is a narrow, deliberate scope boundary: an opening-balance voucher is a
  one-time cutover event expected to predate any period a restaurant would
  actually run this report over.
- No support for a manual `journal` voucher's own counter-account
  overriding the flat "Operating" default — a manual correction that
  happens to touch a fixed-asset or loan-payable account alongside cash
  is classified Operating regardless, a documented simplification (manual
  journals are rare, ad-hoc corrections, not a systematic posting pattern
  this module needs to fully understand).

## Up next

This completes all five slices of `ACCOUNTING_PHASE_5_PLAN.md` (5a AR/AP
Aging, 5b Bank Accounts + Reconciliation, 5d Fixed Assets + Depreciation,
5e Loans, and now 5c Cash Flow). Per the plan's own Part 4, Nepal-specific
tax/compliance treatment of anything built across these five slices stays
an explicit, unresearched Phase 6 question.
