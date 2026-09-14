# Accounting Phase 5, Slice 5d — Fixed Assets + Depreciation

## What this slice builds

**Fixed assets as chart-of-accounts children.** Each fixed asset a restaurant
records (a kitchen oven, a POS terminal, furniture, ...) gets its own child
ledger account under the seeded "1900 Fixed Assets" parent, coded in a reserved
1920–1999 block — the same wrapping pattern Slice 5b established for bank
accounts under "1050 Bank Accounts". Accumulated depreciation is **not** split
per asset: every asset shares the single seeded contra-asset "1910 Accumulated
Depreciation" account, with each asset's own running total tracked in the new
`fixed_assets` table just to know when it's hit its salvage value.

**Acquisition.** "Add Fixed Asset" records the asset and posts Dr the asset's
own account / Cr the funding source — cash, a real bank account (using Slice
5b's own silent-default/picker rules), or Accounts Payable for a purchase on
credit — all in one transaction.

**Depreciation — straight-line, book purposes only.** Per sign-off
(AskUserQuestion, "Recommended"): only straight-line depreciation is supported,
and every report this module produces is explicitly a book/management figure,
never a claim about Nepal tax depreciation treatment — that stays an
unresearched, explicit Phase 6 question, consistent with this engagement's
standing rule against asserting unverified compliance positions.

"Run Depreciation for `<month>`" is a deliberately human-triggered action (no
background cron, matching this codebase's existing pattern everywhere else) that
charges every active asset's elapsed depreciation through the end of the chosen
month. The proration is real calendar-day-based, not a fixed 30/360 convention:
a period entirely inside one month is charged by actual-days-owned over
actual-days-in-that-month, and a period spanning several months prorates only
its first and last partial segments the same way, with whole months in between
charged at the flat monthly rate. This is what makes an asset bought mid-month
(the plan's own test case) come out right, and it also handles a restaurant that
skips a month and later catches up in one run. Every period's charge is capped
so an asset is never depreciated below its own salvage value — the final period
absorbs whatever rounding remainder is left rather than drifting past it.
Re-running for an already-processed month is a no-op: every asset is already
caught up through that date, so nothing posts a second time.

**Disposal — with proceeds and gain/loss.** Per sign-off (AskUserQuestion,
"Recommended"): disposing of an asset supports an optional proceeds amount
(cash or bank) and computes a real gain or loss against book value, rather than
only supporting a zero-proceeds write-off. The posting always balances by
construction — accumulated depreciation + proceeds + any loss equals the
asset's full original cost plus any gain — and the asset's own ledger account
is deactivated afterward since its balance is now exactly zero.

## Two new seed accounts

- **4920 Gain/Loss on Disposal of Fixed Assets** — the balancing plug on a
  disposal, contra-income like 4900/4910 (a gain credits it, a loss debits it).
- **5150 Depreciation Expense** — fixed at 5150, deliberately outside the 5200+
  block reserved for a restaurant's own auto-provisioned expense-category
  accounts, so a growing restaurant's categories can never collide with it.

Two new voucher types were added to support this — `fixed_asset` (covers both
acquisition and disposal, distinguished by narration, same "one type per
business-event category" convention `expense` already follows) and
`depreciation` (one periodic run's charge).

## Verification

- `tsc --noEmit`: clean.
- `eslint .`: 0 errors (same pre-existing unrelated warnings as before, none in
  files this slice touched).
- `vitest run`: **1582 passed** (1574 baseline + 8 new, all in
  `accounting-fixed-assets.test.ts`), covering: cash and credit-funded
  acquisition; the reserved-code-block and balanced-voucher checks; rejecting an
  invalid salvage value or non-positive cost before touching the database;
  depreciation across two assets with different useful lives, including a
  mid-month acquisition's calendar-day proration, verified idempotent on
  re-run for the same month; capping a short-lived asset's final charge at its
  salvage value; disposal computing both a loss and a gain against proceeds,
  confirming the voucher always balances and the asset drops out of future
  depreciation runs. All pre-existing accounting integration tests (81 across
  13 files, including Slice 5a/5b's own) still pass unchanged. The same 8
  pre-existing, unrelated failures from before this slice (a port-mismatch in
  the eSewa gateway callback test, a branch-filtering push-notification test)
  are untouched by any file this slice changed.
- `npm run build`: succeeds.
- Dev server smoke test: the new GET routes return a clean `401` unauthenticated;
  the new POST routes return `400` without a CSRF header — identical to the
  existing Bank Accounts POST route's own behavior (CSRF is checked before
  authentication on every mutating route in this codebase).

## What this slice deliberately does not do

- No Nepal tax depreciation schedule or compliance claim of any kind — every
  figure this module produces is book/management-only, per sign-off.
- No amortization/impairment beyond straight-line depreciation to salvage
  value.
- No partial disposal (selling half of an asset) or asset transfer between
  branches — a fixed asset is acquired once and disposed once, in full.
- No automatic revaluation.

## Up next

Per the sign-off on build order: Slice 5e (Loan accounting — manual
principal/interest split, no amortization-schedule calculator) is next, then
Slice 5c (Cash Flow Statement) last, once both Fixed Assets and Loans give it
real investing/financing voucher patterns to classify against.
