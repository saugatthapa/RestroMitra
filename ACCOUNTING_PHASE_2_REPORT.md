# Accounting Module — Phase 2 Completion Report

Status: **Phase 2 complete.** Built entirely on top of Phase 1's API — no
existing operational code path touched, and nothing posts automatically yet.

## What was built

**Sidebar** — a new "Accounting" item (Back Office group), gated by
`MANAGE_ACCOUNTING`, added alongside Account Books rather than replacing it —
Account Books stays fully reachable until Phase 4 proves the new module has
equivalent operational data, per the plan's own instruction.

**`/dashboard/accounting`** — one tabbed screen (`AccountingBoard.tsx`):

- **Overview** — per-account-type totals (Assets/Liabilities/Equity/Income/
  Expenses), a "Set up Chart of Accounts" action when none exists yet, and a
  plain note that the accounting equation won't hold until Phase 4/5's
  automatic integrations land — not hidden, stated.
- **Chart of Accounts** — list with live balances, add an account, activate/
  deactivate (never delete, matching the schema's own no-delete design).
- **Journal Vouchers** — a line editor (account, debit/credit, amount,
  description) with a live balance check that disables posting until debits
  equal credits; view a posted voucher's lines; reverse with a required
  reason.
- **Day Book** — the same voucher list and viewer, unfiltered by type — the
  full chronological record.
- **Ledger Accounts** — pick an account, see its full statement with a
  running balance computed in the correct direction for that account's own
  normal balance.
- **Periods** — create/close/reopen (reopen gated to
  `REOPEN_ACCOUNTING_PERIOD`), and the one-time Opening Balance Voucher
  action for cutover.

**New API** — two small read endpoints: `GET .../accounting/overview`
(per-account balances + type totals) and `GET .../accounting/chart-of-
accounts/[accountId]/ledger` (one account's statement with running balance),
backed by a new `src/lib/accounting/balances.ts` helper.

## Verification

- 4 new integration tests (`accounting-balances.test.ts`) covering: correct
  signed balance for both a debit-normal and a credit-normal account after
  two opposing postings; running balance in date order across two vouchers;
  an account from another restaurant correctly returns not-found; balance
  math is unaffected by deactivating an account. All passing, alongside the
  8 from Phase 1 — 12/12.
- Full suite: 1509 passed, same 8 pre-existing environment-only failures as
  Phase 1 (missing `GROQ_API_KEY`/`PORT`), still unrelated to this work.
- `tsc --noEmit`, `eslint .`, `npm run build`: all clean. Confirmed the new
  page and API route respond correctly (clean redirect/401, no crash) via a
  live dev-server smoke test.

## What Phase 2 deliberately does NOT do

No automatic posting — Phase 4 is untouched. No financial statements
(Trial Balance/P&L/Balance Sheet/Cash Flow) — that's Phase 3, and would be
mostly empty right now since only manual/opening-balance vouchers exist. No
period-overlap enforcement beyond the simple range check already in the
Phase 1 API. Bilingual label added for the nav item (English/Nepali) matching
the rest of the sidebar, but the Accounting screen itself is English-only for
now, same scope boundary as most other Phase 1/2-stage screens in this app.

## Next step

Phase 3 (Financial statements — Trial Balance, P&L, Balance Sheet; Cash Flow
deferred to Phase 5) per `ACCOUNTING_MODULE_PLAN.md`. Not started; awaiting
confirmation to proceed.
