# Branch-scoped inventory (P2 foundation)

Phase 3 (P2) deliverable, and a prerequisite for branch-to-branch transfer
specifically — but written to benefit every inventory-touching P2 item
(COGS, wastage tracking, physical stock count), not just transfer.

## What changed

Before this: `inventoryItems.currentStockMilliunits` was the ONLY stock
figure that existed — one shared number per restaurant, regardless of how
many branches it had. A purchase or a sale at any branch moved the same
restaurant-wide total.

After this: every stock movement (`stock_movements`) and every purchase
(`purchases`) now carries a `branch_id` — which branch physically received
a delivery, which branch's sale deducted recipe stock, which branch a
manual adjustment applies to. A new table, `branch_inventory_levels`, holds
one row per (branch, item) and is the per-branch stock figure.

**`inventoryItems.currentStockMilliunits` was deliberately left alone** —
it stays the authoritative restaurant-wide total, updated exactly as
before. Every existing caller (low-stock alerts, the Items tab, weighted-
average purchase costing) keeps reading/writing it unchanged. The new
per-branch table is purely additive, incremented in lockstep with the
restaurant-wide total inside the same transaction (see
`recordStockMovement` in `src/lib/inventory.ts`), so the two can never
drift apart — the sum of every branch's level always exactly equals the
restaurant-wide total for that item. This was chosen deliberately over
replacing the restaurant-wide column outright, to keep the blast radius of
this change to "add a new capability" rather than "rewrite every existing
inventory read path" — see the Verification section below for how this
invariant was actually checked, not just asserted.

Purchase costing (the weighted-average `costPerUnitInPaisa`) stays
restaurant-wide, not per-branch — a blended cost basis across wherever
purchases happen, matching how a small restaurant actually thinks about
"what does a kg of chicken cost us," not a separate cost basis per branch.

## The migration (`drizzle/0030` + `0031`)

Two migrations, matching this project's established two-step pattern for
adding a NOT NULL column to a non-empty table (same pattern as
`0021`/`0022`'s expense-category backfill):

- **0030** adds `branch_id` nullable to `purchases` and `stock_movements`,
  creates `branch_inventory_levels`, then backfills every existing row:
  - `purchases.branch_id` → the restaurant's main branch (`is_main = true`).
    Every restaurant has had exactly one main branch since onboarding
    (`src/app/api/onboarding/restaurant/route.ts`), and branches are never
    hard-deleted (no DELETE endpoint exists), so this is always resolvable
    — not a guess about whether a main branch exists, just about which
    physical branch received a specific historical delivery.
  - `stock_movements.branch_id` for `sale_deduction` rows → the branch of
    the order it references (`orders.branch_id` — a REAL signal, orders
    have always been branch-scoped).
  - `stock_movements.branch_id` for `purchase` rows → the branch of the
    purchase it references (itself just backfilled above).
  - Everything else (manual adjustments, and any row whose reference no
    longer exists) → the restaurant's main branch, same best-effort
    default as purchases.
  - `branch_inventory_levels` is then seeded from the now-fully-backfilled
    movement ledger: one row per (branch, item), summing every signed
    delta.
- **0031** sets both columns `NOT NULL` once the backfill above guarantees
  no row is left without one.

**Honest caveat on the backfill, stated once here rather than buried in a
comment:** for a restaurant that has only ever had one branch — the common
case — the main-branch default is exactly correct, not an approximation.
For a genuinely multi-branch restaurant with purchase/adjustment history
predating this migration, attributing ALL of that history to the main
branch is a best-effort assumption, not a reconstruction of fact — there
was never a real record of which branch physically received a given
delivery before this column existed. If that per-branch split matters for
an existing multi-branch restaurant, a physical stock count (tracked
separately as its own P2 item) is the intended way to correct any
resulting drift going forward, not something this migration claims to fix
retroactively.

## Verification (run for real, this session)

Tested against a genuine clone of this project's populated dev database
(`pg_dump`-equivalent `CREATE DATABASE ... TEMPLATE ...`, not a synthetic
fixture), which at clone time held 175 restaurants, 189 branches (multiple
restaurants with 2 branches — the multi-branch backfill path was
genuinely exercised, not just the single-branch case), 9 purchases, 25
stock movements:

- `npm run db:migrate` — both migrations applied cleanly, zero errors.
- Zero `NULL` `branch_id` values remaining on `purchases` or
  `stock_movements` after the backfill.
- Every backfilled `purchases.branch_id` / `stock_movements.branch_id`
  belongs to the SAME restaurant as the row it's on (no cross-tenant
  leakage introduced by the backfill's join logic).
- Every `sale_deduction` movement's `branch_id` exactly matches its
  referenced order's real `branch_id` (the accurate-signal path, checked
  directly, not assumed).
- For every inventory item, `SUM(branch_inventory_levels.current_stock_milliunits)`
  across all its branches exactly equals `inventory_items.current_stock_milliunits`
  — the invariant the whole design depends on, verified by query, not
  just asserted in a comment.
- Full regression against this cloned, migrated database: `tsc --noEmit`
  clean, `npm run lint` clean (0 errors, the same 6 pre-existing
  warnings), **642/642** vitest tests passing, production build
  succeeding, **5/5** E2E tests passing.

## What this unlocks, and what's still separate work

This is the foundation, not the feature. Still to build on top of it (own
P2 items, not done here): a physical stock count workflow (branch-scoped),
a dedicated wastage movement type, COGS reporting, and the actual
branch-to-branch transfer flow itself (creating a transfer record and the
paired negative/positive stock movements it implies). The `InventoryBoard`
UI does not yet expose a branch picker on the purchase/adjustment forms —
today those API routes require `branchId` in the request body, which the
UI needs to start sending; until that UI work lands, the purchase and
adjustment endpoints will reject requests missing it.
