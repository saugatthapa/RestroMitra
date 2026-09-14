# Accounting Module — Phase 7 Implementation Plan (Advanced Features)

Status: **research + planning only — no schema or code changes made yet.**
Same discipline as every prior phase's plan in this engagement: this is
reviewed before any of it lands, as a whole or slice by slice.

Per `ACCOUNTING_MODULE_PLAN.md`'s own Phase 7 description, this phase
builds: the remaining accounting reports (cash/bank book, inventory
valuation, branch profitability, an accounting audit/journal report),
branch consolidation, an Accounting Health validator, and a
Tally-compatible export. Phases 1–6 are all complete and committed
(double-entry ledger, vouchers, AR/AP, bank reconciliation, cash flow,
fixed assets, loans, VAT, tax depreciation) — Phase 7 is the last phase
named in the master plan.

## Part 1 — What already exists, and what's genuinely missing

Reading the actual codebase (not the master plan's one-line description)
before scoping this phase surfaced a correction worth flagging up front:
**branch consolidation is not greenfield.** The other three areas are
genuinely new work, roughly as the master plan sized them.

### 1.1 Reports already shipped (Phases 5–6) — not part of Phase 7

`REPORT_TABS` in `AccountingBoard.tsx` already has: Trial Balance, Profit
& Loss, Balance Sheet, Cash Flow (5c), AR/AP Aging (5a), VAT Return (6c),
Tax Depreciation (6e) — backed by `financial-statements.ts`, `aging.ts`,
`cash-flow.ts`, `vat-return.ts`, `tax-depreciation.ts`. Bank reconciliation
(5b) and Loans (5e) also shipped as their own tabs, not report-only.

### 1.2 Genuinely missing reports (confirmed absent by direct inspection)

- **Cash Book / Bank Book.** No report exists that lists, chronologically,
  every transaction touching a specific cash or bank account with a
  running balance — the classic "cash book" a bookkeeper reconciles by
  hand. The Cash Flow statement (5c) summarizes cash movement by category
  over a period; it does not itemize individual transactions.
- **Inventory valuation.** No accounting report values on-hand inventory
  (there's inventory-quantity tracking elsewhere in the app for
  operations, but no accounting statement tying it to the Inventory
  account's ledger balance or a costing method).
- **Branch profitability.** No branch-filtered P&L exists today — see 1.3.
- **An accounting-specific audit/journal report.** `audit_logs` (used
  everywhere in this codebase, including every accounting route touched
  in Phases 4–6) is a security/RBAC trail ("who did what, when") — it is
  not a chronological, printable listing of every posted voucher with its
  lines, which is what a bookkeeper or an auditor actually wants to review
  ledger activity. That's genuinely missing.

### 1.3 Branch consolidation — smaller than the master plan implies

`branches` is already a full table (`schema.ts` ~line 585) — a restaurant
already has one-to-many branches (`isMain` flag, wired through orders,
tables, purchases, register shifts). More importantly, **the accounting
schema already carries `branchId`**: every `accountingVouchers` row and
`chartOfAccounts` row has a `branchId` column, and the schema's own
comment there says this was a deliberate Phase 1 decision made specifically
to avoid a much bigger retrofit later. Branch-specific accounts (e.g. a
branch's own Cash on Hand) are already representable; a `branchId: null`
account is restaurant-wide.

What's actually missing is only the **reporting layer**:
`financial-statements.ts`, `aging.ts`, and `cash-flow.ts` all currently
take a `restaurantId` only — no report generator accepts an optional
`branchId` filter or produces a side-by-side multi-branch rollup. So
"branch consolidation" in Phase 7 means: add branch filtering to the
existing report generators, and add a "by branch" view that runs each
report per-branch and totals them. It does not mean inventing multi-
location support — that already exists and has since Phase 1.

### 1.4 Accounting Health validator — genuinely missing

No diagnostic/self-check exists. `ACCOUNTING_ACCOUNT_3200_WRITE_GUARD_REPORT.md`
is a narrow, single-case point-fix inside `postVoucher()` (blocking manual
journal entries from touching account 3200, Opening Balance Equity) — a
good precedent for "detect a books-integrity problem," but it is not a
diagnostic tool, has no report, and covers exactly one case. A real health
validator (books balanced at the ledger level, no orphaned voucher lines,
no vouchers referencing inactive/deleted accounts, AR/AP sub-ledger
reconciled against its own control account) is net-new: a new
`src/lib/accounting/health.ts`, an API route, and a dashboard view.

### 1.5 Tally-compatible export — genuinely missing, and the riskiest item

No export exists for voucher-based accounting data (`GET
/api/restaurants/[slug]/ledger/export` is a CSV of the old, pre-Phase-1,
single-sided `ledger_entries` table — unrelated). Nothing in the codebase
references Tally's XML import format, in code or in comments. The master
plan's optimism — "straightforward once real vouchers exist" — is
directionally right about the *data shape* (`accountingVouchers`/
`accountingVoucherLines` are dated, numbered, debit/credit lines against a
chart of accounts, which is what Tally's XML import wants), but the actual
XML schema mapping, the voucher-type → Tally-voucher-type naming
convention, and — critically — **verification against a real Tally
install** are all unresearched and, in this environment, **unverifiable**:
there is no licensed Tally software available here to actually test an
import against. This is flagged explicitly in Part 3 as the one item in
this phase that carries a real, unavoidable risk of shipping a plausible-
looking export that a real Tally import silently rejects or misfiles —
mirroring the same "medium-confidence, clearly caveated" posture Slice 6e
took with Nepal's disposal/de-minimis tax rules.

## Part 2 — Architecture decisions

### 2.1 Branch filtering: add an optional `branchId` param, never a second code path

Every report generator (`financial-statements.ts`, `aging.ts`,
`cash-flow.ts`) gains an optional `branchId?: string` parameter that, when
present, adds `eq(accountingVouchers.branchId, branchId)` (or the
equivalent on `chartOfAccounts.branchId` for balance-sheet-style balance
queries) to its existing query — never a parallel, branch-only
implementation that could drift from the restaurant-wide one. Restaurant-
wide accounts (`branchId IS NULL`, e.g. shared liability/equity accounts)
are always included regardless of which branch is selected, since they
aren't any one branch's — this mirrors how `chartOfAccounts.branchId`
nullability already works elsewhere (bank-accounts.ts, cash-flow.ts's own
cash-account resolution).

### 2.2 Cash Book / Bank Book: one report, parameterized by account

Rather than two separate reports, one `getCashOrBankBookReport(params: {
restaurantId; accountId; fromDate; toDate })` function works for any
account (a seeded cash account or any `bank_accounts`-wrapped account) —
"Cash Book" and "Bank Book" are just this same report pointed at different
accounts, selected via a dropdown in the UI (mirroring how Bank
Reconciliation (5b) already lets an owner pick which bank account to view).
A running balance is computed by walking voucher lines touching that
account in date order, starting from the opening balance as of `fromDate`
(via the existing `getAccountBalances` helper cash-flow.ts already uses).

### 2.3 Inventory valuation: report on the existing Inventory account, not a new costing engine

This codebase has no per-item inventory costing method (FIFO/weighted-
average) in the accounting sense — inventory quantity tracking exists for
operations (stock levels, low-stock alerts) but is not tied to a per-unit
cost basis feeding the ledger. Building a full costing engine is out of
scope for a report-only slice. Phase 7's inventory valuation report will
value inventory the way this codebase's own postings already do:
Inventory's own chart-of-accounts balance (debited on purchase, credited
to COGS on sale, per Phase 4's existing `integrations/purchases.ts` /
order-completion postings) *is* the accounting valuation already, at
whatever costing convention those postings use today. This report exposes
that balance clearly (as of a date, with a breakdown of what moved it in
the period) rather than inventing a second, independent valuation method
that could disagree with the ledger — consistent with this engagement's
standing rule never to post or represent a number the ledger doesn't
already agree with.

### 2.4 Accounting audit/journal report: read-only, voucher-sourced, distinct from `audit_logs`

A new report lists every posted voucher in a date range — date, voucher
number, type, narration, and its full debit/credit lines — sortable/
filterable by voucher type and (per 2.1) branch. Pure read query against
`accountingVouchers`/`accountingVoucherLines`, no new schema. Deliberately
not merged into the existing RBAC `audit_logs` viewer — that log answers
"who changed what in the app," this answers "what did the books record,"
and conflating the two would make both harder to use for their actual
purpose.

### 2.5 Health validator: read-only diagnostics, never auto-repair

Every prior phase in this engagement has been careful that accounting
code either posts correctly-balanced vouchers or refuses to post at all
(the double-entry invariant is enforced at `postVoucher()` — see the 3200
write-guard precedent). A health validator's job is to surface anything
that looks wrong for a human to investigate, not to silently "fix" the
books — auto-repair of financial data is exactly the kind of action this
engagement's standing constraints treat as needing explicit human
judgment, not code. Each check returns a pass/fail plus enough detail
(account codes, voucher IDs) for an owner or accountant to locate the
actual records. Planned checks:
  - Every account's own running balance recomputed from its lines matches
    `getAccountBalances`' cached/derived view (catches any drift between
    however balances are read vs. how they're stored/derived).
  - Every voucher's lines sum to debit = credit (this should be
    structurally impossible given `postVoucher()`'s own invariant, but
    checking it directly is cheap and catches any future code path that
    bypasses `postVoucher()`).
  - No voucher line references a `chartOfAccounts` row that's been
    deactivated (`isActive: false`) after the line was posted — not an
    error, but worth surfacing since it affects report continuity.
  - AR/AP aging's derived totals (5a) reconcile against the Accounts
    Receivable / Accounts Payable control account balances.
  - No orphaned voucher lines (a line whose `voucherId` doesn't resolve to
    an existing voucher) — a schema-level FK should already prevent this;
    checking it directly is a cheap sanity floor, not an expectation of
    finding anything.

### 2.6 Tally export: XML per Tally's documented "Voucher" import format, explicitly caveated as unverified

Given no licensed Tally install is reachable from this environment (see
1.5), this slice will be built to Tally's publicly documented XML import
schema (`ENVELOPE` / `REQUESTDATA` / `TALLYMESSAGE` with `VOUCHER` nodes),
researched via public documentation rather than assumed from general
knowledge, with every voucher type mapped to its nearest standard Tally
voucher type (e.g. this app's `sales` → Tally "Sales", `purchase` →
"Purchase", `payment`/`expense` → "Payment", `journal` → "Journal"). The
export will be presented in the UI with an explicit, permanent caveat —
"generated to Tally's documented XML format; not verified against a real
Tally import in this environment — test with a small date range first" —
the same posture as Slice 6e's medium-confidence tax mechanics, not a
placeholder to be quietly removed later. **This is flagged as the one
slice in this phase most worth confirming with the user before/while
building**, since "export that looks right but silently fails a real
Tally import" is a worse outcome than not offering the feature, and the
user may have (or be able to get) actual Tally access to test against,
which this environment cannot.

## Part 3 — Slice-by-slice plan

Six slices, each independently shippable and regression-tested, in the
order below (roughly least-to-most novel/risky, matching how Phases 4–6
were sequenced in this engagement):

- **7a — Cash Book / Bank Book report.** Per 2.2. Lowest risk: pure
  aggregation over existing data, closest in shape to the already-shipped
  Bank Reconciliation and Cash Flow reports.
- **7b — Branch filtering on existing reports + branch profitability
  view.** Per 2.1/2.3. Low risk: additive parameter on existing, already-
  tested report generators; no new schema (branchId already exists).
- **7c — Accounting audit/journal report.** Per 2.4. Low risk: a new
  read-only query, no new schema.
- **7d — Inventory valuation report.** Per 2.3. Low-medium risk: the
  report itself is simple, but its own doc/UI must be explicit that it
  reflects the ledger's existing costing convention, not an independent
  valuation, to avoid an owner mistakenly treating it as a second source
  of truth that could disagree with COGS.
- **7e — Accounting Health validator.** Per 2.5. Medium risk: the checks
  themselves are individually simple, but false positives (flagging a
  legitimate historical state as "unhealthy," e.g. a deliberately
  deactivated account with old lines) need care — each check's report
  language will distinguish "needs investigation" from "definite error."
- **7f — Tally-compatible export.** Per 2.6. Highest risk, sequenced last
  deliberately (same reasoning Slice 6e used for saving the least-
  code-reuse, least-verifiable slice for last). Worth a direct check-in
  with the user before or during this slice specifically, given the
  verification gap described in 1.5/2.6.

**Exit criteria per slice:** matches every prior phase in this
engagement — `tsc`/`eslint` clean, targeted + full `vitest run` green
(modulo the same 8 pre-existing unrelated baseline failures), `npm run
build` clean, an unauthenticated dev-server smoke test on any new route,
a written slice report, and a local-only commit with the required
trailers.

## Part 4 — What stays out of scope

- **A real inventory costing engine (FIFO/weighted-average) with its own
  per-unit cost basis.** Per 2.3, that's a materially bigger feature than
  "add a report" and isn't part of what the master plan's Phase 7
  description asked for.
- **Auto-repair from the Health validator.** Per 2.5 — diagnostics only.
- **Direct Tally API integration (live sync).** Only file-based XML
  export, matching the master plan's own phrasing ("Tally-compatible
  export").
- **Any claim that the Tally export is verified against real Tally
  software**, until and unless that verification actually happens (see
  2.6) — the caveat stays in the shipped UI permanently otherwise.
