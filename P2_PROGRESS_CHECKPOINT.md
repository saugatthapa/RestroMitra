# RestroMitra — Phase 3 (P2) Progress Checkpoint

**Scope of this note:** a status checkpoint partway through P2, not the final phase report — P2 has 7 items total (COGS reporting, wastage tracking, physical stock count, supplier dues/AP, payroll improvements, cash register/shift management, branch-to-branch transfer) and 5 of those are still not started. This is a pause point to show verified work so far and confirm direction before taking on the remaining, larger items — cash register in particular is being built from scratch, not extending something that exists.

Same rule as every prior phase report: everything below was verified by actually running the commands shown, against a real clone of your dev database, not inferred or assumed.

## Architecture decision (your call, now binding)

Branch-to-branch inventory transfer needed a decision before any of the inventory-touching P2 work could proceed safely: today inventory is one shared pool per restaurant, not split per branch. You chose **"branch-scope it for real"** over the two cheaper alternatives (keep it restaurant-wide and skip transfer, or defer the decision). That's now built and verified as the foundation everything below sits on.

## 1. Branch-scoped inventory foundation

`purchases` and `stock_movements` now carry a required `branchId`, and a new `branch_inventory_levels` table tracks per-branch stock atomically, in lockstep with the existing restaurant-wide cached total — updated inside the same transaction, so the two can never drift apart. `inventoryItems.currentStockMilliunits` stays as-is (restaurant-wide), so every existing read path (low-stock alerts, weighted-average costing, the Items tab) keeps working unmodified.

Two-migration nullable-then-`NOT NULL` pattern, same as this project's existing precedent (`0021`/`0022`, the expense-category backfill): `0030` adds the columns nullable plus a hand-written backfill (purchases → main branch; sale-deduction movements → their order's real branch; purchase-type movements → their purchase's branch; everything else → main branch, honestly documented as best-effort, not fact), `0031` sets `NOT NULL`. Full design writeup and the exact verification queries are in `BRANCH_INVENTORY.md`.

**Verified this session** against a fresh clone of your dev database (`dhankipos_p2_scratch`): migrations apply cleanly, zero rows left with a null `branchId`, and the core invariant — sum of a menu item's branch-level stock always equals its restaurant-wide cached total — holds exactly with zero mismatches.

## 2. COGS reporting (P2-1)

`getCogsSummary()` derives cost of goods sold from each menu item's recipe (bill-of-materials) times its ingredients' weighted-average cost, applied across every completed order in the report's date range. Surfaced on the Reports dashboard as **Cost of goods sold** and **Gross profit** tiles.

Deliberately kept separate from the existing **Net profit** (revenue minus manually-logged expenses) rather than folded together — an owner who logs ingredient spend as a plain "Inventory" expense instead of using Recipes would otherwise get double-counted. When some sold items don't have a recipe defined yet, the UI says so explicitly (an amber note naming how many of how many items are covered) instead of presenting a partial total as if it were complete.

**Verified**: hand-computed test fixture (2 burgers × Rs 44/serving = Rs 88 COGS) matches exactly; a branch with no orders reports zero, not an error; `netProfitInPaisa` provably unaffected by the new COGS math.

## 3. Wastage tracking (P2-2)

A new `"waste"` stock-movement type, split out from the generic "adjustment" bucket, plus a structured reason (`spoilage`, `expired`, `breakage`, `overproduction`, `theft_or_loss`, `other`) — so "a stock count came up short" and "a bag of onions spoiled" are distinguishable, not both an undifferentiated adjustment with only a free-text note. Wired through the adjustment API and a "This is waste" checkbox + reason dropdown on the Inventory board.

Your own earlier audit of this feature flagged a real gap: wastage was recordable but had nowhere to be *read back*. Closed that this session — `getWastageSummary()` now surfaces total wastage cost plus a by-reason breakdown ("60% of this month's waste was spoilage") on the Reports dashboard, next to a new **Wastage cost** KPI tile.

**Verified**: hand-computed test fixture (3 items across 2 reasons, one plain adjustment and one out-of-range movement deliberately included as negative controls) matches exactly — the non-waste and out-of-range rows are correctly excluded.

## Full verification run (this session)

Against `dhankipos_p2_scratch` (a real clone of dev data, migrations 0030–0032 applied):

- `npx tsc --noEmit` — clean
- `npm run lint` — 0 errors (6 pre-existing warnings, none in touched files)
- `npx vitest run` — **648/648 passing** (12 new: 3 COGS + 3 wastage + 6 branch-scoping fixture updates)
- `npm run build` — production build succeeds
- `npx playwright test` — **5/5 E2E passing**

## What's not done yet

The remaining 5 P2 items — physical stock count, supplier dues (accounts payable), payroll improvements, cash register/shift management, and the branch-to-branch transfer feature itself (the architecture decision is resolved and the foundation is built, but transfer records/API/UI don't exist yet) — have not been started this session.

## Status

Committed locally (`3601424`) but **not pushed** to GitHub — same standing preference as the P0 and P1 phases. Delivered alongside this report as a git bundle.
