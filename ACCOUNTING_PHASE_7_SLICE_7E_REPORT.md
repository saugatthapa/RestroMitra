# Accounting Phase 7, Slice 7e — Accounting Health Validator

## What was built

Per `ACCOUNTING_PHASE_7_PLAN.md` Part 2.5/Part 3's 7e, this slice adds a
read-only diagnostics screen that runs five checks over a restaurant's own
books and reports what it finds — never auto-repairs anything, per the
plan's own explicit constraint that fixing financial data is a human
judgment call, not something code should do silently.

- A new "Health Check" report tab: an overall status banner (pass / info /
  informational notes / needs attention), a re-run button, and one card
  per check with its own pass/info/attention badge, a plain-language
  description of what it verifies, and — when it finds something — a list
  of specific, actionable messages (account codes, voucher numbers) an
  owner or accountant can use to go find the actual record.

## Three severities, not two — resolving a design question the plan itself raised

The plan calls out that "false positives... need care — each check's
report language will distinguish 'needs investigation' from 'definite
error.'" A deactivated account that still has old posting history is the
plan's own example of something that looks alarming but is actually
expected, deliberate behavior (a restaurant retires an account on purpose
while keeping its history visible in past-period reports). Flagging that
the same way as an unbalanced voucher would train users to ignore the
whole screen.

So this implementation uses three severities instead of two:
`"pass"` (nothing found), `"info"` (found something, but it's a normal,
benign state — currently only the deactivated-account check ever returns
this), and `"attention"` (found something that should structurally never
happen and genuinely warrants a look). The overall banner rolls up to the
worst severity present, but `"info"` alone never escalates to `"attention"`
— confirmed by its own test.

## The five checks, and how each is actually verified

1. **Account balances agree with the ledger.** Deliberately does *not*
   call into `balances.ts`'s own `getAccountBalances` arithmetic a second
   time — that would just be checking the same code against itself. It
   re-derives each account's total debit/credit via a SQL-side
   `GROUP BY`/`sum()` (the pattern this codebase already uses elsewhere,
   e.g. `reports.ts`'s `getTopMenuItems`) and compares that against what
   `getAccountBalances`' own app-side `reduce` reports. Two genuinely
   different code paths over the same data — if a future change makes them
   disagree, this is what catches it.
2. **Every voucher balances.** `postVoucher()` enforces debit = credit at
   write time, so this should be structurally impossible through the
   normal application — the test proves the check actually works by
   bypassing `postVoucher()` entirely (a raw insert directly into
   `accounting_vouchers`/`accounting_voucher_lines`, the only way to
   construct an unbalanced voucher, since the DB's own per-line check
   constraint only enforces "one-sided," not cross-row balance — see that
   constraint's own comment).
3. **Deactivated accounts with posting history.** Informational only, per
   the design discussion above.
4. **AR/AP aging reconciles with the control accounts.** Slice 5a's aging
   report only ever sees a control-account line that's tagged with a
   `customerId`/`supplierId` (`isNotNull(partyColumn)` in `aging.ts`'s own
   query) — an untagged line (a manual journal adjustment straight against
   Accounts Receivable, say) still moves the control account's own ledger
   balance but is invisible to the aging report's party breakdown. This
   check catches exactly that gap and names which side (AR or AP) has it,
   with a message that explains the likely cause rather than just stating
   a number mismatch.
5. **No orphaned voucher lines.** A schema-level foreign key
   (`ON DELETE CASCADE` from lines to vouchers) already makes this
   impossible — included anyway per the plan's own "cheap sanity floor,
   not an expectation of finding anything."

## What changed, file by file

- **`src/lib/accounting/health-check.ts`** (new) —
  `getAccountingHealthReport({ restaurantId, timezone })`, returning
  `{ restaurantId, asOfDate, generatedAt, overallSeverity, checks }` where
  each of the 5 checks is `{ id, label, description, severity, issues }`.
  Every check runs in parallel (`Promise.all`); nothing in this module
  ever writes.
- **`src/app/api/restaurants/[slug]/accounting/reports/health/route.ts`**
  (new) — `GET`, gated `MANAGE_ACCOUNTING`. Deliberately not branch-scoped
  and not date-ranged — this reports on the whole restaurant's books as of
  today, not a period.
- **`src/app/dashboard/accounting/AccountingBoard.tsx`** — new "Health
  Check" entry in `REPORT_TABS`; new `AccountingHealthCheckTab` component
  with its own severity badge styling and a manual re-run control (this
  screen has no date range to drive a re-fetch, unlike every other report
  tab, so a re-run button takes that role instead).
- **`src/db/__tests__/accounting-health-check.test.ts`** (new, 5 tests) —
  a clean restaurant reports all-pass; a raw-inserted unbalanced voucher is
  caught (and confirms balance-consistency stays "pass" on the same data,
  since that's a genuinely separate concern); a deactivated account with
  history reports "info" without escalating the overall severity; an
  untagged AR posting is caught by the reconciliation check; a fully
  tagged AR posting reconciles cleanly.

## Verification

- `npx tsc --noEmit` — clean.
- `npx eslint` on all four touched files — clean.
- Targeted tests (`accounting-health-check.test.ts`, `accounting-aging.test.ts`,
  `check-constraints.test.ts`) — 19/19 passing, all 5 new health-check
  tests passing on first run.
- Full `npx vitest run` — 1648/1656 passing. The 8 failures are the same
  pre-existing, unrelated baseline seen in every prior slice's report in
  this engagement — none touch this slice's code.
- `npm run build` — succeeds cleanly.
- Dev-server smoke test: unauthenticated `GET` on the new health route →
  `401` with a clean `{"error":"Not authenticated"}` body; an unsupported
  method (`PUT`) → `405`.

## Deliberately out of scope

- **Auto-repair.** Per the plan's own 2.5/Part 4 — every check is
  diagnostics only. If a check finds something, fixing it is a manual
  accounting action (a correcting journal entry, reactivating an account),
  not a button on this screen.
- **Scheduled/automatic health checks (e.g. a nightly cron alerting an
  owner).** This is an on-demand screen a user opens; wiring it into a
  notification pipeline is a different, separable feature.
- **Branch-scoped health checks.** The checks operate on the whole
  restaurant's books — matching how Branch Profitability (7b) also
  deliberately stays whole-restaurant rather than reading the header's
  branch switcher, since narrowing a diagnostic to one branch could hide a
  real issue sitting in an unscoped voucher.

## What's next

Per `ACCOUNTING_PHASE_7_PLAN.md` Part 3, the final slice is **7f —
Tally-compatible export**, which the plan itself flags as highest risk and
recommends checking in with the user about before or during, since the
export format can't be verified against real Tally software in this
environment.
