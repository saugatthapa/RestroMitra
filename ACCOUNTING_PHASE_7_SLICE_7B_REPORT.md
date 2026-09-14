# Accounting Phase 7, Slice 7b — Branch Filtering + Branch Profitability

## What was built

Per `ACCOUNTING_PHASE_7_PLAN.md` Part 3's 7b, this slice adds branch scoping
to the existing accounting reports and a new side-by-side branch
profitability view.

- Trial Balance, Profit & Loss, Balance Sheet, Cash Flow, and both AR/AP
  Aging reports now accept an optional branch filter. In the UI, this is
  driven by the same header branch switcher (`useActiveBranch`) that
  already scopes the general Reports dashboard — switching branches at the
  top of the app now scopes every accounting report the same way, with no
  new report-local picker to learn.
- A new **Branch Profitability** report tab shows Profit & Loss broken out
  side by side, one column per branch, for a period — the one genuinely
  new report this slice adds (the plan's "branch profitability" item).

## A correction to the plan's own design, caught before writing code

`ACCOUNTING_PHASE_7_PLAN.md`'s Part 2.1 proposed filtering branch-scoped
reports by adding a `branchId` condition on **either** the voucher or the
chart-of-accounts row, describing them as roughly equivalent options. Before
implementing, re-reading `schema.ts`'s own top-of-file comment on the
accounting tables (written back in Phase 1) surfaced that this was already
explicitly decided, and decided the other way: *"Every voucher and voucher
line always carries a branchId, even though an account may be
restaurant-wide... so branch reporting always works off the transaction,
never depends on the account being split per branch."*

So every change in this slice filters by `accounting_vouchers.branchId` —
never by `chart_of_accounts.branchId` — which also turned out to be the
simpler implementation: the chart of accounts itself never needs filtering,
since a restaurant-wide account (the common case: one Sales Revenue
account, one Accounts Payable account) naturally shows a zero balance for
a branch that never posted to it, and the existing "only show non-zero
rows" logic in every statement already drops it. This is a correction I
made independently while implementing, not something asked about — the
schema comment already settled it unambiguously, so there was no genuine
fork left to raise.

## Security: reusing the app's existing branch-access pattern, not inventing one

Every touched route follows the exact pattern
`/api/restaurants/[slug]/reports/summary` (the general Reports dashboard)
already established for `?branchId=`: a caller whose own role grant is
locked to one branch (`resolveRestaurantContext`'s own `branchId`) has that
branch forced regardless of what the query string asks for; an
unrestricted caller's requested branch is verified via `requireBranchAccess`
(belongs to this restaurant, is active) before use. This is the same
primitive roughly 170 other routes in this codebase already use — nothing
new was invented here, and no new test was written to re-prove
`requireBranchAccess` itself works, since it's already exercised
extensively elsewhere.

## A documented, deliberate limitation: branch-filtered AR/AP aging

Unlike the other reports, AR/AP aging isn't a clean "narrow which vouchers
count" filter. The aging report replays a party's full charge/payment
history in FIFO order to age their outstanding balance — and a customer or
supplier isn't tied to one branch (a customer could run a tab at Branch A
and pay it off at Branch B). Filtering to one branch's own lines means a
payment made at a *different* branch won't appear to offset a charge
recorded at this one, so a branch-filtered aging report can show a party as
more "outstanding" at this branch than they truly are company-wide.

This is called out explicitly — in `aging.ts`'s own code comment and in the
UI (a note appears under the branch scope line whenever a specific branch
is selected) — rather than either silently shipping a subtly-wrong number
or refusing to filter aging by branch at all. It's still a genuinely useful
view ("what does this branch's own activity with this party look like"),
just not a claim about the party's true consolidated balance.

## What changed, file by file

- **`src/lib/accounting/balances.ts`** — `getAccountBalances` gains an
  optional `branchId`, filtering the voucher-lines query by
  `accounting_vouchers.branchId`. `accounts` itself stays unfiltered (see
  the correction above).
- **`src/lib/accounting/financial-statements.ts`** — `getTrialBalance`,
  `getProfitAndLoss`, `getBalanceSheet` each gain an optional `branchId`,
  threaded into their `getAccountBalances` calls, and echoed back on each
  result. New `getBranchProfitability({ restaurantId, fromDate?, toDate?,
  restrictToBranchIds? })` — runs `getProfitAndLoss` once per branch (few
  branches per restaurant, same "small row counts" trade-off this module's
  balance math already documents) and returns one row per branch plus
  totals.
- **`src/lib/accounting/cash-flow.ts`** — `getCashFlowStatement` gains an
  optional `branchId`, threaded into both its beginning/ending balance
  queries and its own two voucher-line queries (the flat pass and the loan
  pass). Cash-account *resolution* (which accounts count as cash) stays
  restaurant-wide; only the voucher activity read from them is branch-scoped.
- **`src/lib/accounting/aging.ts`** — `computeAging` (and both exported
  wrappers) gain an optional `branchId`, with the FIFO-limitation comment
  described above.
- **Six report routes** (`trial-balance`, `profit-and-loss`,
  `balance-sheet`, `cash-flow`, `ap-aging`, `ar-aging`) — each gained the
  `?branchId=` security pattern described above.
- **`src/app/api/restaurants/[slug]/accounting/reports/branch-profitability/route.ts`**
  (new) — `GET`, gated `MANAGE_ACCOUNTING`. No `?branchId=` narrowing (the
  report's whole point is comparing branches); a branch-restricted caller's
  own grant limits the response to just their branch via
  `restrictToBranchIds`.
- **`src/app/dashboard/accounting/AccountingBoard.tsx`** — every existing
  report component now reads `useActiveBranch()` and appends `branchId` to
  its own fetch when a specific branch is selected, with a small
  `BranchScopeNote` showing the current scope (hidden entirely for a
  single-branch restaurant, matching the header switcher's own "hide if
  ≤1 branch" convention). AR/AP Aging additionally shows the FIFO-limitation
  note when branch-scoped. New "Branch Profitability" report tab —
  deliberately does *not* read the branch switcher (narrowing an
  already-comparative report to one branch would defeat its purpose).
- **Tests**: added branch-scoping cases to
  `accounting-financial-statements.test.ts` (a branch-scoped P&L excludes
  another branch's sale while the unfiltered report includes both;
  `getBranchProfitability` breaks a period out per branch, summing to the
  unfiltered total; `restrictToBranchIds` narrows correctly),
  `accounting-cash-flow.test.ts` (a branch-scoped statement only reflects
  that branch's own cash activity and still reconciles), and
  `accounting-aging.test.ts` (a branch-scoped AP aging report only reflects
  charges/payments recorded at that branch). Each new case posts its own
  fresh vouchers dated after every existing assertion in its file, so
  nothing here could perturb an already-passing hand-calculated figure.

## Verification

- `npx tsc --noEmit` — clean.
- `npx eslint` on every touched file — clean.
- Targeted tests (`accounting-financial-statements.test.ts`,
  `accounting-aging.test.ts`, `accounting-cash-flow.test.ts`,
  `accounting-cash-book.test.ts`, `check-constraints.test.ts`) — 29/29
  passing.
- Full `npx vitest run` — 1634/1642 passing. The 8 failures are the same
  pre-existing, unrelated baseline seen in every prior slice's report in
  this engagement — none touch this slice's code.
- `npm run build` — succeeds cleanly.
- Dev-server smoke test: unauthenticated `GET` on all seven touched/new
  report routes → `401` (including with a `?branchId=` query param
  present — the auth check runs before the branch check); an unsupported
  method → `405`. No crash, no stack trace leak.

## Deliberately out of scope

- **Branch filtering on the Cash Book / Bank Book report (7a).** Not named
  in the Phase 7 plan's 7b scope, and it's a different kind of report
  (one specific account's own history, not a restaurant-wide statement) —
  left as a possible future enhancement rather than folded in here.
- **A `?branchId=` narrowing query param on Branch Profitability.** The
  report's purpose is comparing branches; narrowing it to one branch via
  query param would just reproduce what `getProfitAndLoss` already does.
- **Resolving the AR/AP aging branch-filtering limitation** (e.g. by
  attributing a payment made at one branch back to the branch where the
  original charge was recorded). That's a real design question with more
  than one defensible answer — documented clearly instead of guessed at.

## What's next

Per `ACCOUNTING_PHASE_7_PLAN.md` Part 3, the next slice is **7c — an
accounting audit/journal report**: a chronological, printable listing of
every posted voucher with its lines, distinct from the existing RBAC audit
log. Low risk — a new read-only query, no new schema.
