# Double-Entry Accounting Module — Inspection Report & Architecture Plan

Status: **planning only — no schema or code changes made yet.** This document is the
required first step before any implementation: a full inventory of what already
exists, followed by a proposed architecture and migration strategy. Nothing here
has been built.

**Decisions confirmed:**
1. History migration → **clean cutover**. The new ledger starts from an Opening
   Balance Voucher on a chosen cutover date. Existing Account Books data (`ledger_entries`
   and everything it reports on) stays permanently readable as historical archive —
   never deleted, never force-converted into vouchers.
2. Before writing any code → **see the full phase-by-phase plan first** (Part 4 below),
   so scope can be judged before committing engineering time to any of it.
3. Service charge (`orders.serviceChargeInPaisa`) → booked as **restaurant revenue**
   (Dr Cash/Clearing, Cr Service Charge Revenue), matching today's behavior where it
   simply flows into `totalInPaisa` with no staff-distribution mechanism. Not a payable.
4. Discounts (`orders.discountInPaisa`) → booked through a **contra-revenue account**
   (Dr Discounts & Allowances, Cr Sales Revenue at the gross/pre-discount amount), so
   the P&L can show Gross Sales less Discounts = Net Sales, rather than only ever
   seeing the already-netted number the app displays today.
5. This document was revised after external accounting review (see the Review notes
   below Part 3) — five corrections and one new required document (the Accounting
   Policy & Posting Matrix, `ACCOUNTING_POLICY_AND_POSTING_MATRIX.md`) came out of that
   pass. **That matrix must be read alongside this plan before Phase 1 starts** — it's
   the concrete debit/credit answer for every business event this module will touch,
   and Phase 4 in particular is meaningless without it being settled first.

---

## Part 1 — What already exists (inspection report)

### A. Existing accounting-related tables

| Table | Purpose | Shape |
|---|---|---|
| `ledger_entries` | Account Books — the closest thing to a general ledger today | Single-sided: one row = `direction` (credit/debit) + `category` (sales/expense/purchase/due_settlement/capital/withdrawal/payroll/other) + `amountInPaisa`. No paired account, no chart of accounts. The column comment in `schema.ts` says outright: *"not formal double-entry T-account debit/credit, which would require a full chart of accounts this app doesn't have."* |
| `payments` | Every payment/refund against an order | Signed `amountInPaisa` (+payment/−refund), `method`, `receivedInPaisa` (change-due display only), `tipInPaisa`, `splitId`, `reconciledAt`/`reconciledByUserId` |
| `expenses` | Expense requests → approval → payment | `status` (pending_approval/approved/rejected/paid), `paymentMethod`, `isVoided` |
| `purchases` / `purchase_items` | Stock-in from a supplier | `isCredit` flag drives whether the linked ledger entry is marked outstanding |
| `stock_movements` | Every inventory quantity change | `type` (purchase/sale_deduction/adjustment/waste/transfer_out/transfer_in), signed `quantityDeltaMilliunits`, cost snapshot |
| `inventory_items` | Current stock + weighted-average cost | `currentStockMilliunits`, `costPerUnitInPaisa` — both explicitly documented as *derived/cached*, source of truth is `stock_movements` |
| `staff_salary_configs` / `payroll_payments` | Standing salary config + append-only payout log | No accrual/payable row — payroll only records the moment money is actually paid |
| `register_shifts` / `register_cash_movements` / `register_shift_corrections` | Cash Register (till tracking) | Fully separate from Account Books by design |
| `daily_closes` | Frozen daily snapshot (revenue/COGS/profit/cash variance) | Immutable row per business day, doesn't lock further writes, just raises the permission bar |
| `order_bill_splits` | Split-bill payer shares | Tags payments, doesn't affect accounting math |

**No chart of accounts, no journal/voucher table, no accounting-equation enforcement anywhere.** Every table above is single-entry: one amount, one direction, no "debit this account, credit that account" pairing.

### B. Existing accounting-related APIs

- `POST /api/restaurants/[slug]/orders/[orderId]/payments` — records a payment (the primary revenue-recognition trigger alongside order completion)
- `POST /api/restaurants/[slug]/orders/[orderId]/refunds` — refund (negative payment row)
- `POST/GET /api/restaurants/[slug]/tables/[tableId]/combined-bill` — multi-order settle (built earlier this session)
- `POST /api/restaurants/[slug]/expenses`, `.../[expenseId]/pay` — expense lifecycle
- `POST /api/restaurants/[slug]/purchases` — stock-in + supplier due
- `POST /api/restaurants/[slug]/register-shifts/*` — Cash Register (open/close/movements/correct)
- `GET /api/restaurants/[slug]/ledger`, `.../ledger/export` — Account Books read + CSV export
- `GET /api/restaurants/[slug]/reconciliation`, `.../reconciliation/export` — payment-method reconciliation (card/wallet/other only; cash is out-of-scope here, handled by Cash Register instead)
- Payroll payout routes under `.../staff/.../payroll`

### C. Existing Account Books functionality

`src/lib/ledger.ts` is the single write-choke-point (`recordLedgerEntry`) — every other function (`recordSalesLedgerEntry`, `recordExpenseLedgerEntry`, `recordPurchaseLedgerEntry`, `recordPayrollLedgerEntry`, `reverseExpenseLedgerEntry`, `reversePayrollLedgerEntry`, `settleLedgerDue`) goes through it. `AccountBooksBoard.tsx` shows a Cash In / Cash Out / Net / On-credit-in / On-credit-out strip plus a filterable entry list. Reversals never mutate the original row — they insert an offsetting entry linked by `referenceId`/`referenceType` and flip `isVoided` on the source record. This "append a correction, never rewrite history" discipline already matches what real accounting requires — it's the right instinct, just not expressed as debit/credit account pairs.

### D. Existing Cash Register functionality

Fully covered earlier this session (`src/lib/cash-register.ts`). Answers "what cash should physically be in the drawer," entirely independent of Account Books — computes `opening + cash sales − cash refunds (now a manual entry, see recent change) − cash expenses + additions − drops − payouts`. This is correctly scoped and, per the pasted spec's own §23, should stay separate from formal accounting — it already is.

### E. Existing payment architecture

One `payments` row per payment/refund/split-share, tied to one `orderId`. `computeBillingSummary()` (`src/lib/payments.ts`) derives `paymentStatus` from the sum. No concept of a payment-method-specific clearing account (e.g. "eSewa Clearing") — a card/wallet payment and a cash payment are recorded identically except for the `method` column; nothing currently distinguishes "money sitting in a gateway, not yet settled to the bank" from "money already in the bank."

### F. Existing inventory accounting

Weighted-average costing, fully implemented and battle-tested (`applyPurchaseCosting`, `recordStockMovement` in `src/lib/inventory.ts`). COGS is a frozen per-order-item snapshot (`orderItems.recipeCostInPaisa`), summed by `getCogsSummary()` in `src/lib/reports.ts`. **This is good, reusable logic — the spec's own §16 says not to rebuild it, and there's no reason to.** The gap is purely that inventory's *value* (stock qty × cost) never gets posted anywhere as an asset balance — it's computed on demand, never booked.

### G. Existing expense accounting

Ledger posting is correctly gated to the "paid" moment only (never draft/pending/approved) — `recordExpenseLedgerEntry` fires exactly once, whether that's at creation (direct-pay flow) or later via the `pay` route. This is exactly the "don't create duplicate entries when status changes" discipline §21 of the pasted spec asks for. Already correct.

### H. Existing payroll accounting

Payroll posts to `ledger_entries` (`category: "payroll"`) only at actual payout — there's no salary-payable accrual. The spec's §22 wants Dr Salary Expense / Cr Salary Payable when salary *becomes due*, then Dr Salary Payable / Cr Cash when *paid* — that accrual step doesn't exist today and would be new.

### I. Existing customer/supplier dues

Both are **entirely derived, not stored** as a balance. `getSupplierDueReport()` joins `purchases` to `ledger_entries` (`referenceType='purchase'`) and computes `outstanding = amount − settled` live. Customer credit works the same way via `ledgerEntries.customerId`. Settlement (`settleLedgerDue`) is compare-and-swap on `dueStatus`/`settledAmountInPaisa`, recorded as a new `due_settlement` entry rather than mutating the original — again, the right instinct, just missing the second ledger leg (there's no "Accounts Receivable" or "Accounts Payable" *account* being debited/credited — the due-ness is a status flag on the original entry, not a balance in its own right).

### J. Existing permissions

`src/lib/rbac/permissions.ts` already has finance-relevant permissions (`MANAGE_EXPENSES`, `APPROVE_EXPENSE`, `PAY_EXPENSE`, `MANAGE_ACCOUNT_BOOKS`, `MANAGE_CASH_REGISTER`, `CORRECT_CASH_REGISTER`, `MANAGE_DAILY_CLOSING`, `VIEW_PAYROLL`, `MANAGE_PAYROLL`, `VIEW_REPORTS`, `VIEW_PROFIT`) **and an existing `accountant` role** with a sensible default permission set (finance + reports + payroll, but not staff management, menu editing, refunds, or discounts). This is a strong foundation — the new accounting-specific permissions the pasted spec wants (§34) slot in as additions to this existing system, not a replacement.

### K. Existing audit system

`recordAuditLog()` is used at 150+ call sites, already covers most financial mutations with a free-text `action` string + `metadata` JSON. It's a flat activity log, not itself double-entry-aware. The real structural precedent for "never overwrite, append a correction" is `register_shift_corrections` (previous-value/new-value/reason, append-only, parent row updated to reflect current truth) — this is the pattern a voucher reversal design should follow.

### L. What can be reused as-is

Weighted-average inventory costing, COGS snapshot mechanism, Cash Register (keep fully separate per spec §23), Daily Closing (keep as the operational summary per spec §24), the `accountant` role and most existing finance permissions, the audit log, the "append a correction, don't rewrite" discipline already used for expenses/payroll/register corrections, the expense/payroll/purchase lifecycle state machines themselves.

### M. What must be migrated

`ledger_entries` history needs a decision (see Part 3 — this is one of the two open questions). Supplier/customer due-tracking logic needs to be re-pointed at real Accounts Payable/Receivable *accounts* instead of a status flag on the original entry, without breaking `getSupplierDueReport`'s existing consumers.

### N. What must be newly created

Chart of Accounts, accounting periods, voucher header + voucher lines tables, the posting engine (debit=credit enforcement), account-mapping configuration (payment method → clearing account, expense category → expense account, etc.), Trial Balance / P&L / Balance Sheet / Cash Flow report generators, AR/AP aging, fixed assets + depreciation, bank accounts + reconciliation, a configurable tax engine, opening balances, period locking, and the new sidebar section with drill-down.

### O. Potential duplicate/conflicting financial logic to watch for

- **Discounts**: no explicit accounting policy exists today (contra-revenue vs. net sales) — `orders.discountInPaisa` just reduces the order total; a new accounting layer must pick ONE policy and apply it everywhere, per spec §19.
- **Tax**: `orders.taxInPaisa` is computed at order level today with no separate output-tax-payable account; introducing a Tax Payable account without double-counting what's already in `totalInPaisa` needs care.
- **Refunds**: currently just a negative `payments` row; a proper accounting reversal (Dr Sales Returns / Cr Cash) needs to coexist with that row without creating two conflicting pictures of "what happened."
- **Gateway settlement**: nothing today distinguishes "sale happened" from "money reached the bank" — introducing per-gateway clearing accounts is new ground, not a migration of something existing.

---

## Part 2 — Proposed architecture

New tables (additive, `snake_case`, paisa-integer convention matching the rest of the schema):

- **`chart_of_accounts`** — id, code, name, type (asset/liability/equity/income/expense), parent_account_id, normal_balance, branch_id (nullable = restaurant-wide), is_system_account, is_active, restaurant_id
- **`accounting_periods`** — restaurant_id, branch_id, period_start/end, status (open/closed/reopened), closed_by/at, reopened_by/at/reason
- **`accounting_vouchers`** — id, voucher_number (see numbering below), voucher_type (enum matching §6's 16 types), voucher_date, reference, narration, branch_id, created_by, approved_by, posted_by, status (draft/approved/posted/reversed/cancelled), reversal_of_voucher_id / reversed_by_voucher_id, **source_type, source_id, posting_event** (see idempotency below)
- **`accounting_voucher_lines`** — id, voucher_id, account_id, debit_in_paisa, credit_in_paisa (CHECK: exactly one is zero, the other > 0), description, customer_id/supplier_id/order_id (nullable references), tax_rate_id
- **`account_mappings`** — restaurant_id, mapping_key (e.g. `payment_method:cash`, `expense_category:<id>`, `ledger_category:sales`), account_id — this is what makes account selection configurable instead of hard-coded, per spec §42/§43
- **`fixed_assets`** / **`depreciation_entries`** — per spec §27, Phase 5
- **`bank_accounts`** / **`bank_reconciliations`** — per spec §25/§26, Phase 5
- **`tax_rates`** — effective-dated, configurable, per spec §20, Phase 6

**Voucher numbering** (review correction #2): each voucher gets a human-traceable number formed as `{TYPE_PREFIX}-{SEQUENCE}` — e.g. `JV-000001` (journal), `SV-000002` (sales), `PV-000003` (purchase), `PMV-000004` (payment), `EV-000005` (expense), `RV-000006` (refund), `CV-000007` (contra/cash-register), `OBV-000001` (opening balance) — matching the pasted spec's own §6 voucher-type list. The sequence counter is **per restaurant, per voucher type** (not per branch — a restaurant with 3 branches still gets one `SV-000123` sequence across all of them, since audit trails are normally reviewed at the restaurant/company level, and per-branch numbering would fragment that). Numbers are never reused or renumbered: a reversed voucher gets its own new number and points back at the original via `reversal_of_voucher_id`, exactly like the "append a correction, don't rewrite" discipline already used for `register_shift_corrections`.

**Account scoping — branch_id vs restaurant_id** (review correction #3): resolved as two separate, independently-configurable things rather than one setting. (a) **Accounts** are restaurant-wide by default (`chart_of_accounts.branch_id = NULL`) — one Sales Revenue account, one Accounts Payable account, etc., shared across every branch. A restaurant *may* opt a specific account into being branch-specific (most commonly "Cash on Hand", to mirror the fact that Cash Register shifts are already tracked per branch) by giving it a `branch_id`, in which case each branch gets its own row under the same parent code. (b) **Every voucher and voucher line always carries a `branch_id`** regardless of whether the accounts it touches are restaurant-wide or branch-specific — inherited from the source record (the order's branch, the expense's branch, etc.), never left null for an automatic posting. This means branch-level P&L and consolidation (Phase 5/7) can always filter by the transaction's own `branch_id`, even for accounts that are shared restaurant-wide — solving the exact "branch consolidation becomes painful" risk the review flagged, without forcing every account to be duplicated per branch.

**Idempotency** (review correction #4 — the most important one): every voucher created by an *automatic* integration (Phase 4+) carries `source_type` (e.g. `"order_completion"`, `"expense_payment"`, `"payroll_payout"`), `source_id` (the order/expense/payout row's id), and `posting_event` (a short fixed string identifying which posting this is for that source, since one order can eventually trigger more than one voucher — e.g. `"sale"` vs a later `"refund"`). A partial unique index on `(restaurant_id, source_type, source_id, posting_event) WHERE source_type IS NOT NULL` means a retried request (a flaky connection, an offline-queue replay, a duplicate webhook) can never produce two vouchers for the same business event — `postVoucher()` checks this key first and returns the existing voucher unchanged on a replay, exactly the same `clientRequestId`-style protection `payments`/`orders` already rely on elsewhere in this codebase, just keyed by the source record instead of a client-generated token (since these postings are triggered by the server itself, not directly by a client submission). Manual journal vouchers (Phase 2's entry form) simply leave all three columns null — the uniqueness constraint doesn't apply to them.

**Posting engine** (`src/lib/accounting/post-voucher.ts`, one new choke point, same convention as `recordLedgerEntry`/`recordStockMovement`): `postVoucher(tx, {type, lines, source_type?, source_id?, posting_event?, ...})` — rejects unless `sum(debit) === sum(credit)`, unless the period is open (or caller holds the reopen permission), and unless every account referenced is active; short-circuits to the existing voucher when the idempotency key already exists. Every existing money-moving function (`recordSalesLedgerEntry`, `recordExpenseLedgerEntry`, `recordPurchaseLedgerEntry`, `recordPayrollLedgerEntry`, cash movements, refunds) gets a new call to this engine **at the same transaction boundary it already writes at** — so posting stays atomic with the business event exactly as the spec's §45 requires, and nothing about the existing operational flow changes from a user's perspective.

**Account Books' future**: Day Book / Cash & Bank / Receivables / Payables become *reports reading from voucher lines*, per spec §41 — `ledger_entries` stops being written to going forward once the integrations in Phase 4 land, but the table is never dropped (§38/§39 — no hard deletes of financial history).

---

## Part 3 — Two decisions needed before Phase 1 starts

Everything above is inspection and design — safe to write down without touching the database. Two real decisions remain that are business/accounting-policy calls, not technical ones, and guessing wrong here produces financial statements that *look* authoritative but are quietly built on a wrong assumption:

**1. What happens to the existing `ledger_entries` history?** Faithfully converting old entries into proper vouchers means *inferring* the missing second leg of each historical transaction (e.g., which specific account a manual "other" category entry from 8 months ago should have hit) — for entries with a clear order/payment/expense link this is reliable; for old manual entries with no linked record, it's a best guess that could misstate historical reports. The safer alternative is starting the new double-entry ledger from a clean **Opening Balance Voucher** on a cutover date, while keeping all old Account Books data permanently readable (never deleted) as a historical archive rather than converted.

**2. Given the true size of this** — this document alone reflects two full codebase-research passes, and Part 2 lists 8 new tables, a new posting engine, and 6 new financial-statement report generators before Phase 4 (the integrations) even starts — the pasted spec's own §48 phases this deliberately, with tests and verification after each one. Confirming this before Phase 1 begins means Phase 1 (Chart of Accounts + voucher engine + double-entry validation + posting, with no UI and no integrations yet) can be scoped, built, tested, and reviewed on its own, rather than all 7 phases landing at once with no checkpoint.

---

### Review notes

This plan was reviewed before Phase 1 began. The review approved the overall
architecture, migration strategy, and phase structure, and raised five
corrections plus one required follow-up document — all incorporated above:

1. Phase 1 reframed as "prove the engine with manual vouchers," not "start posting."
2. Explicit voucher-numbering strategy (type-prefixed, per-restaurant sequence).
3. Explicit branch_id vs restaurant_id account-scoping decision.
4. Idempotency protection added to the posting engine (`source_type`/`source_id`/`posting_event`).
5. Cash Flow statement moved out of Phase 3 (data-starved) into Phase 5 (real prerequisites).

The review's larger point — that Phase 4 cannot start without an explicit,
approved debit/credit answer for every business event, or "developers will end
up making accounting decisions while coding" — produced a new companion
document: **`ACCOUNTING_POLICY_AND_POSTING_MATRIX.md`**. It defines exactly
which accounts every sale, tax, discount, service charge, tip, refund,
purchase, expense, payroll, cash-register, and owner-capital event debits and
credits, grounded in this codebase's actual schema fields (not a generic
textbook example) — including the two business-policy calls it required
(service charge → revenue, discounts → contra-revenue) confirmed above. That
document should be read alongside this one before Phase 1 starts, since
Phase 1's seed chart of accounts is now meant to match it exactly rather than
being designed twice.

---

## Part 4 — Phase-by-phase plan

No calendar estimates below — this session has no reliable way to predict wall-clock
engineering time, and a made-up number would be worse than none. Instead, each
phase lists what actually gets built, what existing files it touches (i.e. what
could regress if it's rushed), and the real risk in it. Sizes are relative to
each other (Small / Medium / Large / Very Large), based on new-table count,
new-file count, and how many existing call sites need updating.

Each phase ends with the same checklist the pasted spec itself asks for (§48):
run the full test suite, re-verify existing features (`tsc`/`eslint`/build),
check migrations applied cleanly, re-check permissions/multi-tenant isolation.
No phase is "done" without that.

### Phase 1 — Accounting database foundation — **Medium**

**Builds — and, per review correction #1, this is deliberately scoped as
"prove the engine with manual entry," not "start posting":** `chart_of_accounts`,
`accounting_periods`, `accounting_vouchers`, `accounting_voucher_lines`,
`account_mappings` tables + migration; seed data for the default chart of
accounts, now specifically the tree the Accounting Policy & Posting Matrix
document defines (not a generic textbook COA); `postVoucher()` posting engine
in a new `src/lib/accounting/` module enforcing debit=credit, account-active,
period-open, and the source/idempotency check described above; CRUD for Chart
of Accounts (API + a bare-bones settings page, not the full sidebar yet); the
Opening Balance Voucher flow for cutover. **Nothing operational calls
`postVoucher()` yet in this phase** — every voucher that exists at the end of
Phase 1 was entered by hand (manual journal vouchers + the one-time opening
balance voucher). That's the actual proof the engine is correct, before any
automatic integration depends on it.

**Touches existing files:** none of the operational code paths yet — this phase
is purely additive schema + one new library module. Zero risk to POS/payments/
expenses/payroll/inventory, because nothing calls into it yet.

**Real risk:** getting the Chart of Accounts hierarchy and `account_mappings`
shape right, since every later phase builds on it — a schema mistake here is
cheap to fix now (nothing depends on it) and expensive to fix in Phase 4+
(once integrations and reports are reading from it).

**Exit criteria:** can manually create a balanced voucher via API and have it
rejected if unbalanced; Chart of Accounts seeded and browsable; full test suite
still green (it will be, since nothing existing was touched).

### Phase 2 — Core accounting UI — **Medium**

**Builds:** the new collapsible "Accounting" sidebar section (§2) replacing the
"Account Books" nav item; Overview dashboard shell (§3 — Assets/Liabilities/
Equity/Performance/Warnings, reading from whatever Phase 1 data exists, which
is very little until Phase 4); Day Book (§8) and Ledger Accounts (§9) screens
reading from `accounting_voucher_lines`; a manual Journal Voucher entry form (§7).

**Touches existing files:** the dashboard shell/sidebar nav config (adding a
section, not removing Account Books yet — the old page stays reachable until
Phase 4 proves the new one has equivalent data).

**Real risk:** low technically, but this is the phase where "simple enough for
a non-accountant owner, detailed enough for an accountant" (§40) either works or
doesn't — worth a real look at the UI before Phase 3 builds reports on top of it.

**Exit criteria:** an accountant-permission user can manually post a balanced
journal voucher and see it in the Day Book and in both accounts' ledgers with a
correct running balance.

### Phase 3 — Financial statements — **Medium**

**Builds:** Trial Balance, Profit & Loss, Balance Sheet (§10–12) — all pure
read/aggregation logic over `accounting_voucher_lines`, grouped by account
type/hierarchy. Drill-down from a report line to its ledger to its voucher
(§40). **Cash Flow (§13) is deliberately NOT built in this phase** — see
review correction #5 below.

**Touches existing files:** none — still purely additive, and still
data-starved until Phase 4, since only manually-entered journal vouchers exist
so far.

**Real risk:** Balance Sheet won't actually balance (Assets = Liabilities +
Equity) until *every* money-relevant flow posts through the voucher engine —
that's not fully true until Phase 4/5 land. Worth stating plainly rather than
demoing a Balance Sheet that looks right by coincidence of limited test data.

**Exit criteria:** Trial Balance's own debit/credit totals match by
construction (guaranteed by Phase 1's posting engine); P&L/Balance Sheet
computations are correct for whatever vouchers exist, verified against
hand-calculated fixtures in tests.

**Review correction #5 — Cash Flow moved out of this phase.** P&L and Balance
Sheet are legitimate the moment vouchers exist, even a small manually-entered
set. A proper indirect-method Cash Flow statement is different: it needs every
transaction correctly classified as operating/investing/financing, and needs
real opening/closing Cash *and* Bank balances across a full period — none of
which is meaningfully true until Phase 4's integrations and Phase 5's Cash &
Bank management both exist. Promising it in Phase 3 would mean either shipping
a Cash Flow report that's technically present but not yet trustworthy, or
building it twice. It's now listed under Phase 5 instead, once its actual
prerequisites are real.

### Phase 4 — Automatic integrations — **Very Large, highest risk**

**Builds:** the actual wiring — every existing money-moving function gets a
new call into `postVoucher()` at its existing transaction boundary:
- Order completion / payment recording → Sales Voucher (§17)
- Refunds → reversal voucher, original never deleted (§18)
- Expenses (`recordExpenseLedgerEntry`/`reverseExpenseLedgerEntry`) → Expense
  Voucher / reversal (§21)
- Purchases (`recordPurchaseLedgerEntry`) → Purchase Voucher (§16)
- Payroll (`recordPayrollLedgerEntry`/reversal) → Payroll Voucher, plus the
  NEW salary-payable accrual step that doesn't exist today (§22)
- Cash Register cash movements → Contra Voucher where appropriate (§23)
- Discounts → whichever policy gets picked in §19, applied consistently

**Touches existing files:** `src/lib/ledger.ts` and every route/lib file listed
in the Part 1 inspection above (payments route, expenses route + `pay` route,
purchases route, payroll payout route, refunds route). This is the phase where
regressions in *already-working, revenue-critical* code are possible if rushed
— every one of those call sites currently works correctly today.

**Real risk:** this is the phase to be most careful with, and the one to
budget the most review time for. Recommend it lands as several small, separately
tested changes (one integration at a time — sales first, then expenses, then
purchases, then payroll, then refunds) rather than one giant change, exactly
matching how this session has been handling every other change to this codebase
this whole conversation.

**Exit criteria:** for each integration, a real transaction of that type
produces a correctly-balanced voucher AND the existing feature (the order still
completes, the expense still gets marked paid, etc.) behaves exactly as before
— full regression suite green after each one, not just at the end.

### Phase 5 — Business accounting — **Large**

**Builds:** Accounts Receivable / Accounts Payable as real accounts with aging
(§14/§15) — re-pointing the existing (already-working) due-tracking logic at
proper ledger accounts instead of a status flag; Cash & Bank management +
manual bank reconciliation (§25/§26); the Opening Balance Voucher's actual use
(cutover happens here); Fixed Assets + Depreciation (§27, genuinely new — no
prior art in the codebase); Owner Capital/Drawings (§28); basic Loan accounting
(§29); **the Cash Flow statement (§13, moved here per review correction #5)** —
now buildable for real, since Bank accounts exist and Phase 4's integrations
mean every transaction is classified and opening/closing balances are genuine.

**Touches existing files:** `src/lib/supplier-dues.ts` and the customer-credit
equivalent — carefully, since `getSupplierDueReport()` has existing consumers
that must keep working identically.

**Real risk:** Fixed Assets/Depreciation and Loans are the two areas with zero
existing code to build on — more design-from-scratch than integration.

### Phase 6 — Tax and compliance — **Medium, policy-sensitive**

**Builds:** configurable `tax_rates` (effective-dated, per §20), Output/Input
tax tracking, tax reports, credit/debit notes.

**Real risk:** the pasted spec's own instruction applies directly here — *"Do
not claim Nepal-specific legal compliance without verifying the current Nepal
tax/VAT requirements."* This phase needs actual research into current Nepali
VAT rules before any hard behavior is built, not an assumption carried over
from general accounting knowledge.

### Phase 7 — Advanced features — **Medium**

**Builds:** the remaining Accounting Reports (§35 — AR/AP aging variants,
cash/bank books, inventory valuation, tax summaries, branch profitability,
audit report), branch consolidation, the Accounting Health validator (§44),
and finally the Tally-compatible export (§49) — which becomes straightforward
once real vouchers/ledger accounts exist, unlike trying to export from today's
single-sided `ledger_entries`.

---

**Where this leaves things:** nothing has been built. This document is the
report + plan the pasted spec's own §47/§48 asked for before any code. The
natural next step, if you want to proceed, is Phase 1 alone — it's additive,
touches nothing that currently works, and gives something concrete to review
before Phase 2 builds UI on top of it.
