# Accounting Phase 7, Slice 7d — Inventory Valuation

## What was built

Per `ACCOUNTING_PHASE_7_PLAN.md` Part 2.3/Part 3's 7d, this slice adds a
report exposing the Inventory account's own ledger balance — as of a date,
with a breakdown of what moved it in a period — so an owner can see the
accounting value of stock on hand without leaving the books.

- A new "Inventory Valuation" report tab: a date range, five summary tiles
  (Opening, Purchases, Cost of Goods Sold, Adjustments, Closing), and a
  line-level table in the same shape as Slice 7a's Cash Book, so the summary
  numbers are always traceable to the individual vouchers behind them.

## The design fork the plan itself flagged, and how it was resolved

Part 2.3 of the plan explicitly calls out that this codebase has no
per-item inventory costing method (FIFO/weighted-average) feeding the
ledger — inventory quantity tracking exists for operations, but isn't tied
to a per-unit cost basis. Rather than invent a second, independent
valuation method that could drift from what the ledger itself already
says, this report values inventory exactly the way this codebase's own
postings already do: **the Inventory account's own chart-of-accounts
balance IS the accounting valuation.**

This was confirmed by direct inspection, not assumption — `grep -rl
"MAPPING_KEYS.INVENTORY"` and reading both hits found only two integration
points that ever touch the Inventory account automatically:

- `integrations/purchases.ts` — a `purchase` voucher debits Inventory
  (increases it).
- `integrations/order-completion.ts` — a sale's own separate COGS leg
  (posted under voucherType `sales`, `postingEvent: "cogs"`, computed from
  `orderItems.recipeCostInPaisa`) credits Inventory (decreases it). The same
  sale's revenue leg never touches Inventory at all.

Everything else that can touch Inventory (a manual journal adjustment, the
one-time opening balance voucher) falls into a third "Adjustments" bucket,
so nothing silently disappears from the categorization even though it
wasn't one of the two automatic integration points.

## Reused, not duplicated

Built directly on Slice 7a's `getCashBookReport` — Inventory is just
another account with an opening balance, a running balance through a
period, and a closing balance. This report's only addition is grouping
that same line-level activity into Purchases / Cost of Goods Sold /
Adjustments by each line's own `voucherType`. It can never disagree with
the Cash Book screen or the generic Ledger Accounts screen about the same
account's history — same posture as every other Phase 7 report that builds
on an existing query rather than a parallel one.

`resolveInventoryAccountId` mirrors `aging.ts`'s own
`resolveControlAccountId` exactly (a lenient, non-throwing lookup) rather
than using `resolveAccountMappings` (which throws on a missing key) —
so this report is viewable, returning `report: null`, before a restaurant
has mapped an Inventory account, consistent with every other Phase 5/6/7
report's "viewable before accounting is fully set up" convention.

## What changed, file by file

- **`src/lib/accounting/inventory-valuation.ts`** (new) —
  `getInventoryValuationReport({ restaurantId, fromDate, toDate })`,
  returning `{ accountId, accountCode, accountName, fromDate, toDate,
  openingValuationInPaisa, closingValuationInPaisa, purchasesInPaisa,
  costOfGoodsSoldInPaisa, adjustmentsInPaisa, lines }` or `null` if no
  active Inventory mapping exists.
- **`src/app/api/restaurants/[slug]/accounting/reports/inventory-valuation/route.ts`**
  (new) — `GET`, gated `MANAGE_ACCOUNTING`. `fromDate`/`toDate` default to
  the current calendar month, same convention as every other period report
  in this module. Deliberately not branch-scoped — `chart_of_accounts`
  itself isn't split per branch (schema.ts's own Phase 1 design comment),
  and a branch breakdown of inventory movement would need a different query
  than `getCashBookReport` provides; same scope boundary Slice 7a's own
  Cash Book already draws.
- **`src/app/dashboard/accounting/AccountingBoard.tsx`** — new "Inventory
  Valuation" entry in `REPORT_TABS`; new `InventoryValuationReportTab`
  component (its own `InventoryValuationData`/`InventoryValuationLine`
  types, named distinctly from the lib module's own exported
  `InventoryValuationReport` type to avoid a collision), reusing the Cash
  Book's line-table layout for visual and structural consistency.
- **`src/db/__tests__/accounting-inventory-valuation.test.ts`** (new, 5
  tests) — opening/closing valuation correctness across an opening-balance
  voucher, a purchase, a sale's COGS leg, and a manual journal adjustment,
  with an out-of-range voucher proving date filtering; a clean empty-period
  case; `null` when no Inventory account is mapped; `null` when the mapped
  account has been deactivated.

## Verification

Sandbox tool execution (`tsc`/`eslint`/`node`-based tooling) was
persistently unavailable for roughly an hour earlier in this session —
every attempt to run the compiler or test suite failed at the sandbox's
own safety-classifier layer before the command could even start, while
ordinary shell commands kept working throughout. In the meantime I did a
manual substitute: re-checked every schema field this module touches
(`chartOfAccounts.isActive`, `accountMappings.accountId`/`mappingKey`/
`restaurantId`) directly against `schema.ts`; diffed
`resolveInventoryAccountId` line-by-line against `aging.ts`'s own,
already-tested `resolveControlAccountId`; confirmed `cash-book.ts`'s
exports match what this module consumes; hand-checked every test
voucher's debit/credit balance and the categorization arithmetic; and
caught one real issue that way (an unnecessary `and(eq(...))` wrapper
around a single condition in the test file, inconsistent with this
codebase's own convention — simplified, unused import removed).

Once tool execution recovered, the full automated suite ran cleanly:

- `npx tsc --noEmit` — clean, no errors.
- `npx eslint` on all four touched files — clean, no errors or warnings.
- Targeted tests (`accounting-inventory-valuation.test.ts`,
  `accounting-cash-book.test.ts`, `check-constraints.test.ts`) — 16/16
  passing, including all 5 new inventory valuation tests on first run.
- Full `npx vitest run` — 1643/1651 passing. The 8 failures are the same
  pre-existing, unrelated baseline seen in every prior slice's report in
  this engagement (a branch-filtering push-notification env assertion and
  a payment-gateway-callback redirect port mismatch) — none touch this
  slice's code.
- `npm run build` — succeeds cleanly; the new
  `/api/restaurants/[slug]/accounting/reports/inventory-valuation` route
  appears in the build output.
- Dev-server smoke test: unauthenticated `GET` on the new route → `401`
  with a clean `{"error":"Not authenticated"}` body (no stack trace leak),
  matching the existing Cash Book route's own behavior exactly; an
  unsupported method (`PUT`) → `405`.

## Deliberately out of scope

- **A second, independent costing method (FIFO/weighted-average).** This
  is the core design decision of this slice, not an oversight — see above.
- **Branch-level inventory movement.** Not supported by the schema's own
  design (Inventory is restaurant-wide, not branch-split) — a branch
  breakdown would need to infer branch from the *voucher* that moved
  Inventory, which is a different, more involved query than this slice's
  reuse of `getCashBookReport` provides.
- **Per-item / per-recipe inventory valuation.** Deliberately restaurant-
  level, matching what the ledger itself tracks.

## What's next

Per `ACCOUNTING_PHASE_7_PLAN.md` Part 3, the next slice is **7e —
Accounting Health validator**, followed by **7f — Tally-compatible
export**, which the plan itself recommends checking in with the user
about before or during, since it can't be verified against real Tally
software in this environment.
