# Accounting Module — Phase 5 Implementation Plan (Business Accounting)

Status: **planning only — no schema or code changes made yet.** Same
discipline as `ACCOUNTING_PHASE_4_PLAN.md`: this is reviewed before any of
it lands, as a whole or slice by slice, per Phase 5's own "Large" risk
rating in `ACCOUNTING_MODULE_PLAN.md`.

## Part 0 — A limitation of this plan, stated plainly

`ACCOUNTING_MODULE_PLAN.md` references numbered sections of an original
spec document (§13, §25–§29) that isn't a file in this repository — it
appears to have been pasted directly into an earlier conversation this
session doesn't have access to. This plan is grounded instead in: (a) what
`ACCOUNTING_MODULE_PLAN.md` and `ACCOUNTING_POLICY_AND_POSTING_MATRIX.md`
already say about each area (both are files in this repo and are quoted
directly below wherever they speak to a Phase 5 topic), (b) the actual
current state of this codebase (verified by reading it, not assumed), and
(c) general double-entry accounting practice where neither of the above
says something specific. Nowhere in this plan is a claim made about what
the original spec's §13/§25–29 specifically required beyond what
`ACCOUNTING_MODULE_PLAN.md` already paraphrases — if the original spec
text is available, it should be re-supplied so this plan can be checked
against it before Part 5's decisions are finalized. Nothing here asserts
Nepal-specific legal/tax treatment for any of this (depreciation methods,
loan interest, etc.) — that stays Phase 6's job, flagged again below where
it matters.

---

## Part 1 — Two module-plan bullets that turn out to already be built

Reading the actual code before planning any of this surfaced a genuinely
good-news finding: two of the six things `ACCOUNTING_MODULE_PLAN.md` lists
under Phase 5 are **already fully implemented**, from earlier phases of
this engagement. Restating them here as "confirm and lightly harden," not
"build."

### 1.1 Owner Capital / Drawings — already buildable today, zero new code

`ACCOUNTING_POLICY_AND_POSTING_MATRIX.md` §11 already specifies this as "no
existing trigger — these only ever happen via a manual Journal Voucher,"
and that Journal Voucher screen (`.../accounting/vouchers/route.ts`,
`voucherType: "journal"`) is already fully generic — it accepts any
combination of accounts and lines a human enters, with no restriction
tying it to sales/expenses/etc. The seed chart of accounts already has
both accounts (3000 Owner Capital, 3100 Owner Drawings). An owner
recording a personal investment or withdrawal today already can, right
now, through that existing screen.

**What's actually missing is a UX nicety, not a capability**: today this
means picking "New Journal Voucher" and manually selecting Owner
Capital/Drawings + Cash on Hand/Bank Account from a generic account
picker, rather than a dedicated "Record Owner Investment" /
"Record Owner Withdrawal" quick-entry form that pre-fills the two lines
and just asks for an amount and a method. **Recommendation**: a small,
low-risk UI-only addition (two thin wrapper forms over the existing
journal-voucher POST, no new backend code) — worth doing for a better
day-one experience, but not blocking anything else in this phase.

### 1.2 Opening Balance Voucher cutover — already fully implemented

Also already built, in full: `.../accounting/opening-balance/route.ts`
exists today and does exactly what
`ACCOUNTING_POLICY_AND_POSTING_MATRIX.md` §12 specifies — a one-time,
human-entered voucher with the Opening Balance Equity (3200) plug account
computed automatically for whatever the entered lines don't already
balance to, hard-rejected as a 409 if a restaurant already has one. What
`ACCOUNTING_MODULE_PLAN.md` means by listing this under Phase 5 is that
**the actual cutover event** — a real restaurant going live on this
module, entering its real account balances as of a chosen date — hasn't
happened for any restaurant yet, not that code needs to be written.

**One real, findable gap worth closing here**: the posting matrix's own
rule — "This is the only voucher ever allowed to touch account 3200" — is
currently a policy statement, not an enforced one. Reading the generic
Journal Voucher route confirms it has no check preventing a manual entry
from also posting to account 3200 at any later date, which would corrupt
the one-time cutover plug. **Recommendation**: add one small guard to the
generic journal-voucher POST route — reject any `voucherType !== "opening_balance"`
line that targets the account mapped to `MAPPING_KEYS.OPENING_BALANCE_EQUITY`
— small, additive, closes a real (if narrow) footgun. Bundled into
whichever slice below touches that route next, or done standalone first
since it's a one-file, ~5-line change with no schema impact.

---

## Part 2 — Cross-cutting decisions

### 2.1 Bank accounts as a chart-of-accounts pattern, not a parallel ledger

`chart_of_accounts` already supports both a parent/child hierarchy
(`parentAccountId`, currently unused by any seed data) and per-branch
scoping (`branchId`, currently only exercised conceptually — no seed
account actually sets it yet). This is the same shape Slice 4d's
auto-provisioned expense-category accounts already proved out (a new
`chart_of_accounts` row + its own `account_mappings` row, created
on-demand, `isSystemAccount: false`). **Recommendation**: model each real
bank account the restaurant adds as its own `chart_of_accounts` row (type
`asset`, `normalBalance: "debit"`, parented under a new "1050 Bank
Accounts" system parent), rather than inventing any new balance-tracking
concept — the existing `getAccountBalances()`/Trial Balance/Balance Sheet
machinery then already reports each bank account correctly with zero new
reporting code. A separate `bank_accounts` table (see 3.2 below) holds
only the *operational* metadata a ledger account has no business
carrying (bank name, account number, opening date, notes) and points at
its `chart_of_accounts` row by id — same relationship shape as `expenses`
→ its auto-provisioned category account, just created explicitly by a
human action ("Add Bank Account") instead of on first use.

### 2.2 What Slice 4d/4f's single default accounts become

Slice 4d added one shared "Bank / Digital Payments" account (1040) for
every non-cash expense/payroll payout method; Slice 4f added one "Bank
Account" (1045) every reconciliation posts into. Both were explicit,
signed-off stopgaps specifically because Phase 5 didn't exist yet. Once
real multi-bank-account support lands, both integrations need a real
choice of WHICH bank account to post to — see 3.2's own migration
approach for how existing restaurants that are already using the Phase-4
default(s) get carried forward without a broken reference.

### 2.3 Reporting math needs a new aggregation shape, not new infrastructure

`getAccountBalances()` (Phase 2/3) aggregates debit/credit totals
per-account. AR/AP aging and per-bank cash flow both need one level
finer: totals grouped by `accounting_voucher_lines.supplier_id` /
`.customer_id` (aging) or by the specific bank account touched (cash
flow), not just by account. This is new query logic, not new schema or a
new posting mechanism — every number it needs is already being written by
Phase 4's postings today.

---

## Part 3 — The slices, in build order

Same "each slice independently shippable and independently tested" rule
as Phase 4 (full `tsc`/`eslint`/`vitest`/`build` plus a live smoke test
after each one). Order below runs lowest-risk/most-grounded-in-existing-
code first, to genuinely-new-design-with-no-prior-art last — mirroring
how Phase 4 sequenced sales (highest confidence) before reconciliation
(most novel).

### Slice 5a — Accounts Receivable / Accounts Payable aging

**What exists**: `getSupplierDueReport()` (`supplier-dues.ts`) and
`getCustomerOutstandingBalance(s)` (`ledger.ts`) already compute aging/
outstanding figures today — but both read `ledger_entries` (Account
Books' own single-entry table), not the double-entry
`accounting_voucher_lines` Phase 4 now populates for every restaurant that
has opted in. `ACCOUNTING_MODULE_PLAN.md` describes this slice as
"re-pointing the existing (already-working) due-tracking logic at proper
ledger accounts instead of a status flag."

**What this builds**: a new, parallel aging report
(`getAccountsReceivableAging` / `getAccountsPayableAging`, new file
`src/lib/accounting/aging.ts`) that computes the identical shape of
report — outstanding balance per supplier/customer, bucketed by age —
by aggregating `accounting_voucher_lines` rows tagged with a
`supplierId`/`customerId` against the Accounts Payable/Receivable
accounts, net of everything reversed. **Additive, not a replacement**:
the existing `ledger_entries`-based reports keep working exactly as
today for every restaurant, whether or not they've enabled automatic
posting — same "Account Books keeps writing in parallel" principle Phase
4 already established. A restaurant with automatic posting OFF simply
sees an empty (or absent) new aging report and keeps using the existing
Supplier Due Report / customer balances exactly as before.

**Real risk**: low. No new schema, no new posting logic, no new triggers
— purely new read-side aggregation over data that already exists for
every Phase-4-enabled restaurant. The main design work is getting the
"bucket by age" math right and deciding what "aging as of" means for a
partially-settled balance (oldest-unsettled-portion-first, matching how
`settleLedgerDue`/`settleCustomerCredit` already allocate lump-sum
payments oldest-first).

**Open decision**: should this new report only be *shown* once a
restaurant has enabled automatic posting (since it's meaningless
otherwise — zero voucher lines to aggregate), or shown always with an
empty state explaining why? Recommend the former, matching how every
Phase 4 accounting screen already gates on the same flag.

**Test plan**: a supplier with several open purchases at different ages,
a partial settlement, a fully-settled purchase dropping out, the customer
mirror, and a restaurant with automatic posting OFF getting an
appropriately empty (not broken) response.

### Slice 5b — Bank accounts + reconciliation upgrade

**What this builds**: a new `bank_accounts` table (id, restaurantId,
chartOfAccountsId, bankName, accountNumber, branchName/notes, isActive,
createdAt) plus CRUD routes under `.../accounting/bank-accounts`, each
"Add Bank Account" action creating its paired `chart_of_accounts` row
under the new 1050 parent (per 2.1) inside the same transaction — same
shape as expense-category auto-provisioning, just human-triggered instead
of on-first-use.

**Updates Slice 4d and 4f**: expense/payroll payment forms and the
reconciliation mark action both need a bank-account picker once more than
one exists, instead of unconditionally resolving
`MAPPING_KEYS.BANK_DIGITAL_PAYMENTS` / `MAPPING_KEYS.BANK_ACCOUNT`. **Open
decision, needs sign-off, not guessed**: for a restaurant with exactly one
bank account (the common case, likely most restaurants for a long while),
should the picker still be shown, or should the single existing account
be silently used as the default with no extra click? Recommend the
latter — same "don't add a decision the user doesn't have to make yet"
principle that shaped the shared-account default itself in Slice 4d.

**Migrating existing restaurants**: any restaurant that already enabled
automatic posting under Slice 4d/4f has real voucher history posted
against the single default 1040/1045 accounts. **Recommendation**: on
first visiting the new Bank Accounts screen, if a restaurant has no
`bank_accounts` rows yet, auto-create one wrapping the *existing* 1040
account (labelled something like "Digital Payments (default)") and,
separately, one wrapping the existing 1045 account (labelled "Bank
Account (default)") — preserving every existing voucher's account
reference exactly as posted, rather than a data migration that touches
historical vouchers. A restaurant can then rename these or add real ones
alongside.

**Manual bank reconciliation, beyond what Slice 4f already does**: Slice
4f already reconciles individual `payments` rows against a Bank Account.
What's still missing (and is what `bank_reconciliations` in the module
plan's schema note is for) is a **bank-statement-level** reconciliation
workflow — a running list of dated bank-statement lines a human can check
off against the bank account's own posted transactions (deposits,
withdrawals, bank fees, interest) to confirm the ledger balance matches
the real bank balance at a point in time, the same "manual checklist, no
bank API" spirit as Slice 4f's own doc comment. **Flagging as real scope,
not assumed away** — this is closer to a small feature in its own right
(a `bank_reconciliations` table tracking statement date + closing
balance + which lines were checked off) than a one-line addition, and is
the piece of this slice most likely to need its own follow-up
conversation on exact UI shape before implementation starts.

**Real risk**: medium. New schema, a real UI surface (account
add/edit/list, a picker wired into two existing flows, the statement-
reconciliation screen), and a migration-shaped decision for existing
Phase-4 restaurants that needs to be gotten right the first time (no
second chance to "silently" relabel a live restaurant's history).

**Test plan**: adding a bank account auto-provisions its ledger account;
a restaurant with pre-existing 1040/1045 history gets them auto-wrapped
correctly on first visit; expense/payroll/reconciliation post against the
newly-chosen bank account instead of the old hardcoded one; the
single-account "no picker needed" default; a statement reconciliation
checking off several transactions and reporting the resulting
book-vs-statement difference.

### Slice 5c — Cash Flow Statement

**What exists**: nothing yet — `financial-statements.ts`'s own doc
comment already explains why it was deliberately deferred here ("it needs
indirect-method reconciliation against operating/investing/financing
activity that only makes sense once Phase 4's automatic postings exist").
That prerequisite is now satisfied (Phase 4 is complete) — and Slice 5b
above gives it a real Bank Accounts concept to state opening/closing cash
positions against, which it would otherwise have to fake against the
single default account.

**What this builds**: an indirect-method Cash Flow Statement (the
standard "start from net income, adjust for non-cash items and working-
capital changes" shape), classifying each voucher's cash-account lines
into operating / investing / financing per fixed rules keyed off voucher
type and the account on the other side of the line (a sales/expense/
payroll voucher's cash movement is operating; owner capital/drawings and
loan principal are financing; fixed-asset purchases — once Slice 5d
exists — are investing). **Sequenced after 5b, and after 5d/5e at least
partially**, since "investing" and "financing" activity classification
depends on Fixed Assets and Loans existing as recognizable voucher
patterns — a Cash Flow Statement built before those two would either be
incomplete (silently missing investing/financing lines) or need
revisiting once they land. Listed here in the module plan's own
narrative order, but the actual dependency graph argues for building it
last among these five, once 5d/5e's own voucher shapes are known and
fixed.

**Real risk**: medium — no new schema or triggers (purely a new report
over existing data, once 5b/5d/5e exist), but the classification-by-
voucher-type ruleset needs to be complete and correct or the statement
simply won't balance to the actual bank-balance change, which is the one
property a Cash Flow Statement is supposed to guarantee.

**Test plan**: a restaurant with a full month of sales/expense/payroll/
loan/asset activity, asserting the statement's computed ending cash
position matches the sum of all bank/cash account balances exactly.

### Slice 5d — Fixed Assets + Depreciation

**What exists**: seed accounts only — 1900 Fixed Assets, 1910 Accumulated
Depreciation (both currently unused placeholders from Phase 1's seed
data). **Genuinely no other prior art in this codebase** — this matches
`ACCOUNTING_MODULE_PLAN.md`'s own flag that this is "more design-from-
scratch than integration."

**What this builds**: a `fixed_assets` table (id, restaurantId, name,
category, acquisitionDate, costInPaisa, usefulLifeMonths, salvageValueInPaisa,
depreciationMethod, disposedAt, chartOfAccountsId-for-its-own-asset-
sub-account — same auto-provisioning pattern as expense categories, so
each asset class gets its own child account under 1900); an "Add Fixed
Asset" action posting Dr [asset's account] / Cr Cash-or-Bank-or-Accounts
Payable (an asset can be bought on credit too) at acquisition; a periodic
(monthly, most likely triggered manually — "Run Depreciation for
<month>" — rather than a background cron, matching this codebase's
existing "nothing runs on a schedule without a human asking for it right
now" pattern seen everywhere else in this engagement) depreciation-
posting action, Dr Depreciation Expense / Cr Accumulated Depreciation,
for each active asset's period charge; a disposal action reversing the
asset off the books.

**Real risk — the highest in this phase, stated plainly**:
straight-line depreciation (cost minus salvage, divided evenly over
useful life) is the one method every accounting system implements first
and is defensible as a sensible default without needing tax-authority
sign-off, since it's a bookkeeping convention, not a tax filing position.
**But**: which depreciation method(s) a restaurant is actually required
or permitted to use for TAX purposes in Nepal is exactly the kind of
question the standing constraint says must never be guessed at or
asserted without verification — that determination belongs to Phase 6
("Tax and compliance," which the module plan itself already flags as
needing real research into current Nepali rules). **Recommendation for
Phase 5's own scope**: build straight-line depreciation only, for BOOK
purposes, with the module's own reports clearly labeled as book/
management figures, not a tax computation — and treat "does this need to
match a specific Nepali tax depreciation schedule" as an explicit Phase
6 question to revisit once that phase's research happens, not something
Phase 5 silently assumes an answer to.

**Test plan**: acquiring an asset (cash and credit), running one month's
depreciation across several assets with different useful lives, a
partial-period first month (an asset bought mid-month), disposal netting
the asset and its accumulated depreciation off the books.

### Slice 5e — Basic Loan accounting

**What exists**: one seed account, 2400 Loans Payable, currently unused.
No other prior art, same as Fixed Assets.

**What this builds**: a `loans` table (id, restaurantId, lenderName,
principalInPaisa, interestRatePercent, startDate, termMonths, its own
auto-provisioned Loans Payable sub-account); a "Record Loan Receipt"
action, Dr Cash/Bank Account, Cr [loan's own Payable sub-account]; a
"Record Loan Repayment" action, Dr [Loans Payable sub-account] for the
principal portion + Dr Interest Expense for the interest portion, Cr
Cash/Bank Account, for one instalment.

**Open decision, flagged not guessed**: does an instalment's principal/
interest split need to be computed by this module (an amortization
schedule), or is it always entered manually per payment by whoever's
recording it (matching how payroll/expenses already never compute
anything on the restaurant's behalf, just record what a human already
knows happened)? **Recommendation**: manual entry of the split for
Phase 5 — an amortization-schedule calculator is a genuinely separate
piece of scope (and a place a rounding-error bug could quietly
misstate real liabilities) that can be added later as a convenience
without changing the posting shape at all.

**Real risk**: medium — new schema and a real but narrow UI surface;
low computational risk if amortization math is deliberately kept out of
scope per the recommendation above.

**Test plan**: recording a loan receipt, recording several repayments
with varying principal/interest splits, confirming the Loans Payable
sub-account balance nets down correctly and never goes negative from a
single restaurant's own repayment history.

---

## Part 4 — Explicitly NOT part of Phase 5

- **Nepal-specific tax/VAT treatment of anything in this phase**
  (depreciation methods, loan interest deductibility, etc.) — Phase 6,
  requires real research before any hard behavior is built, per the
  standing constraint against asserting unverified compliance claims.
- **Automated bank-statement import/matching** (CSV/OFX parsing, bank
  APIs) — Slice 5b's reconciliation stays a manual checklist, same
  "no bank/gateway integration exists in this codebase" reality Slice 4f
  already documented. Confirmed directly relevant to your own note this
  session that RestroMitra isn't registered with any bank or payment
  gateway yet — nothing in this phase changes that or needs it to change.
- **Loan amortization-schedule calculation** — per Slice 5e's own open
  decision, recommended as manual entry for this phase.
- **AR/AP aging replacing the existing Account Books reports** — Slice 5a
  is additive; `ledger_entries`-based reporting keeps working unchanged
  for every restaurant regardless of automatic-posting status.

---

## Part 5 — Open decisions needing sign-off before code starts

1. **Bank accounts modeled as chart-of-accounts child rows** (2.1), not a
   parallel balance-tracking mechanism — the same pattern Slice 4d's
   expense-category auto-provisioning already established.
2. **Existing Slice 4d/4f default accounts (1040/1045) get auto-wrapped
   into a `bank_accounts` row on first visit to the new screen**, for any
   restaurant that already has real voucher history against them, rather
   than a data migration touching historical vouchers (Slice 5b).
3. **A restaurant with exactly one bank account never sees a picker** —
   the single account is used silently by default (Slice 5b).
4. **Bank-statement-level reconciliation (`bank_reconciliations`) is real,
   separately-scoped work within Slice 5b**, not a one-line addition to
   what Slice 4f already built — likely worth its own follow-up
   conversation on UI shape before implementation.
5. **Cash Flow Statement (5c) is sequenced after Fixed Assets/Loans (5d/
   5e)**, not built first despite appearing first in the module plan's own
   narrative order — its investing/financing classification genuinely
   depends on those two existing.
6. **Fixed Assets: straight-line depreciation only, for book purposes**,
   explicitly not a tax computation — Nepal-specific tax depreciation
   treatment stays an open Phase 6 question (Slice 5d).
7. **Loan repayments: manual principal/interest split entry**, no
   amortization-schedule calculator in this phase (Slice 5e).
8. **The account-3200 write-guard** (1.2) — small and low-risk enough to
   just build, but noted here since it's a behavior change (a previously-
   silent gap starts throwing) worth a conscious yes rather than a
   surprise.

None of these block Slice 5a specifically. 5b's decisions (#2/#3/#4) need
resolving before 5b starts; 5d/5e's own open decisions (#6/#7) need
resolving before those two start; #5 only affects sequencing, not any
single slice's own scope.

---

**Where this leaves things:** nothing has been built. Per the same
pattern as Phase 4, the recommended next step — once Part 5's decisions
are confirmed or amended — is Slice 5a alone (AR/AP aging), the lowest-
risk and most-grounded-in-existing-code piece, reviewed and fully
verified on its own before Slice 5b starts.
