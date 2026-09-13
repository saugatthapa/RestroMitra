# Accounting Module — Phase 1 Completion Report

Status: **Phase 1 complete.** Purely additive — no existing table, route, or
operational code path was touched. See `ACCOUNTING_MODULE_PLAN.md` for the
full architecture and `ACCOUNTING_POLICY_AND_POSTING_MATRIX.md` for the
approved debit/credit answer this phase's seed data implements.

## What was built

**Schema** (`drizzle/0082_melodic_madrox.sql`) — six new tables: `chart_of_accounts`,
`accounting_periods`, `accounting_vouchers`, `accounting_voucher_lines`,
`account_mappings`, `accounting_voucher_counters`. All five review corrections
from the external accounting review are reflected here: type-prefixed
sequential voucher numbering, restaurant-wide-by-default/branch-taggable
account scoping, a `source_type`/`source_id`/`posting_event` idempotency key
with its own consistency check constraint, and Cash Flow deliberately absent
(it's a Phase 5 report, not Phase 1/3).

**Posting engine** (`src/lib/accounting/post-voucher.ts`) — `postVoucher()`,
the single choke point every voucher will ever go through. Validates, in
order: every line is one-sided, the voucher balances, an automatic-posting
replay returns the original instead of double-posting, every account exists/
belongs to this restaurant/is active, and the accounting period covering the
voucher date is open (or the caller already holds `REOPEN_ACCOUNTING_PERIOD`).
`reverseVoucher()` posts an equal-and-opposite voucher and marks the original
`reversed` — the original is never edited or deleted.

**Default chart of accounts** (`src/lib/accounting/chart-of-accounts.ts`) —
seeds the exact 22-account tree the posting matrix defines (not a generic
textbook COA), plus the account_mappings a Phase 4 integration will read
(`payment_method:cash`, `control:sales_revenue`, etc. — see
`account-mapping-keys.ts`). Idempotent — safe to re-run.

**API** (`src/app/api/restaurants/[slug]/accounting/`) — Chart of Accounts
list/create/edit, a seed action, manual Journal Voucher posting, voucher
detail + reversal, the one-time Opening Balance Voucher (cutover), and
Accounting Period create/close/reopen. Two new permissions:
`MANAGE_ACCOUNTING` (day-to-day) and `REOPEN_ACCOUNTING_PERIOD` (the
CORRECT_CASH_REGISTER-style higher trust tier), granted to `owner` and
`accountant` by default.

**Tests** (`src/db/__tests__/accounting-posting.test.ts`) — 8 integration
tests: seeding is idempotent, a balanced voucher posts with a correct
sequential number, an unbalanced voucher is rejected, a two-sided/no-sided
line is rejected, an inactive account is rejected, a replayed automatic
posting returns the original instead of double-posting, reversal produces
an equal-and-opposite voucher and marks the original reversed (and refuses a
second reversal), and a closed period blocks posting unless explicitly
allowed.

## Verification (Phase 1 exit criteria, per the plan)

- Manual balanced voucher via API: **works** — `POST .../accounting/vouchers`.
- Unbalanced voucher rejected: **works** — `AccountingError`, no rows inserted.
- Chart of Accounts seeded and browsable: **works** — `POST .../accounting/seed`
  then `GET .../accounting/chart-of-accounts`.
- Full test suite still green: **1509 passed**, 8 pre-existing failures
  unrelated to this change (missing `GROQ_API_KEY`/`PORT` env vars after this
  session's container reset — confirmed by checking `.env.local`, not caused
  by anything in this diff).
- `tsc --noEmit`, `eslint .`, and `npm run build`: all clean.

## What Phase 1 deliberately does NOT do

Nothing calls `postVoucher()` from any operational code path yet — no order,
payment, expense, purchase, or payroll flow posts automatically. `ledger_entries`
(Account Books) is completely untouched and still the only thing any existing
screen reads from. There is no UI yet beyond the API itself (Phase 2). Per-
expense-category accounts (5200+) aren't seeded — they're created as a
restaurant actually maps its categories, not guessed here. The payroll
cash-basis-vs-accrual decision flagged in the posting matrix is still open,
since nothing in Phase 1 touches payroll at all.

## Next step

Phase 2 (Core accounting UI) per `ACCOUNTING_MODULE_PLAN.md` — the sidebar
section, Day Book, Ledger Accounts, and a proper Journal Voucher entry form
on top of the API this phase built. Not started; awaiting confirmation to
proceed, same as Phase 1 was.
