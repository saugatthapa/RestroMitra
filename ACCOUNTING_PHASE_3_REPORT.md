# Accounting Module — Phase 3 Completion Report

Status: **Phase 3 complete.** Built entirely on top of Phase 1/2's posting
engine and balance math — no existing operational code path touched, and
nothing posts automatically yet.

## What was built

**Trial Balance, Profit & Loss, and Balance Sheet** — the three statements
the plan's own Phase 3 scope calls for. **Cash Flow is deliberately NOT
included** — per the pasted review's correction #5 (already folded into
`ACCOUNTING_MODULE_PLAN.md` before Phase 1 started), it needs indirect-method
reconciliation against real operating/investing/financing activity, which
only exists once Phase 4's automatic postings land. It's relocated to
Phase 5.

**`src/lib/accounting/financial-statements.ts`** (new) — three functions
built on top of Phase 2's `getAccountBalances()`:

- `getTrialBalance({ restaurantId, asOfDate? })` — every account's balance
  as of a date (or since inception), split into Debit/Credit columns. An
  account's balance is placed on its own normal side when positive; an
  abnormal (negative) balance is placed on the opposite side as a positive
  number instead of a negative one, which is how a Trial Balance is
  conventionally read. This split preserves the column-total identity even
  when an abnormal balance exists — proven below, not just tested.
- `getProfitAndLoss({ restaurantId, fromDate?, toDate? })` — income and
  expense activity for a period (both bounds optional, independent; omit
  both for since-inception).
- `getBalanceSheet({ restaurantId, asOfDate? })` — assets, liabilities, and
  equity as of a date, with a computed **Current Period Earnings** line
  folded into Equity (net income since inception through that date). There
  are no period-closing/retained-earnings-transfer entries yet, so without
  this line the sheet would go out of balance the moment any income or
  expense voucher posts.

**`src/lib/accounting/balances.ts`** — `getAccountBalances()` gained two
optional parameters, `fromDate`/`toDate` (both inclusive), so the financial
statements can reuse the exact same aggregation Phase 2's screens already
rely on rather than duplicating it.

**Three new report API routes** under
`.../accounting/reports/{trial-balance,profit-and-loss,balance-sheet}`,
each a thin `GET` wrapping the matching function, with `?asOfDate=` /
`?fromDate=&toDate=` query params validated against a plain `YYYY-MM-DD`
schema (`reportDateSchema` in `src/lib/validation/accounting.ts`) — an
invalid or missing date param just falls back to "no filter" rather than
erroring, since these are optional report filters, not form input.

**A new "Reports" tab** in `AccountingBoard.tsx`, with its own Trial
Balance / Profit & Loss / Balance Sheet sub-tabs and date pickers. Every
account name in every report is a link that switches to the existing
Ledger Accounts tab with that account pre-selected — the drill-down the
Phase 2 report noted as "planned for Phase 3, not yet implemented."

## The balancing proof (why these numbers are guaranteed consistent, not just tested to be)

For any set of vouchers `postVoucher()` will accept, `sum(debit) ==
sum(credit)` per voucher, so summed across every voucher: `sum over
debit-normal accounts of (debit − credit) == sum over credit-normal
accounts of (credit − debit)`. That's exactly `sum(balance) over
debit-normal accounts == sum(balance) over credit-normal accounts` — call
it `S`.

Splitting each account's balance onto the Trial Balance's Debit or Credit
column by sign (normal side if positive, opposite side if negative) still
preserves that identity: total Debit column `= D_pos − C_neg`, total Credit
column `= C_pos − D_neg`, and since `D_pos + D_neg = S = C_pos + C_neg`,
those two totals are equal regardless of how balances are distributed
across accounts, or whether any individual account is "abnormal." This is
also why the Balance Sheet's `Current Period Earnings` line makes `Assets =
Liabilities + Equity` hold arithmetically: net income (income − expense) is
just `S` restricted to the income/expense subset, folded into Equity.

**What this guarantees and what it doesn't**: the reports are arithmetically
self-consistent by construction — a real bug would have to write outside
`postVoucher()` to break it, which is why `isBalanced` is still computed and
surfaced rather than assumed. It does **not** mean the Balance Sheet
reflects every real balance a restaurant actually has (inventory value,
accrued-but-unpaid liabilities, depreciation, etc.) — that completeness
only arrives with Phase 4/5's automatic postings. The UI says this
explicitly under the Balance Sheet.

## Verification

- 5 new integration tests (`accounting-financial-statements.test.ts`)
  against a hand-calculated fixture (an opening investment, two sales in
  different months, one expense): Trial Balance as of Jan 31 matches both
  by construction (`isBalanced`) and by hand-calculated totals; Profit &
  Loss for January excludes the February sale; Profit & Loss since
  inception includes both; Balance Sheet as of Jan 31 and as of Feb 28 both
  balance via the Current Period Earnings line, with figures matching hand
  calculation. All 5 passing, alongside the 12 from Phases 1–2 — 17/17
  accounting-specific tests total.
- Full suite: 1518 passed, same 8 pre-existing environment-only failures as
  Phases 1–2 (missing `GROQ_API_KEY`, dev `PORT` mismatch) — confirmed
  unrelated, not a regression.
- `tsc --noEmit`, `eslint .`, `npm run build`: all clean.

## What Phase 3 deliberately does NOT do

No Cash Flow statement — relocated to Phase 5 per the review correction.
No automatic posting — Phase 4 is still untouched, so these reports are
only as complete as whatever's been manually entered (plus any Opening
Balance Voucher). No PDF/export or scheduled report generation — out of
scope for this phase. No retained-earnings closing entries — Current
Period Earnings is computed on the fly from all-time income/expense
activity rather than being "swept" into Owner Capital at a period boundary,
which is a design choice appropriate until a real fiscal-year-close
workflow is needed.

## Next step

Phase 4 (Automatic integrations — the highest-risk phase in the plan,
recommended to land as several small, separately-tested changes rather
than one large one). Not started; awaiting confirmation to proceed.
