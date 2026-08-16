# Phase 7 — Inventory, recipes, suppliers, purchases: status notes

Scope per the product spec: give restaurants a real stock ledger — suppliers, tracked
ingredients, purchases (stock-in), a bill-of-ingredients ("recipe") per menu item, and
automatic stock deduction as orders move through the kitchen — instead of running
inventory entirely off-system.

## What's done and verified

- **Schema** (`src/db/schema.ts`, migration `0005_dazzling_shriek.sql`): six new tables
  — `suppliers`, `inventory_items`, `purchases`, `purchase_items`, `stock_movements`,
  `recipe_items` — all tenant-scoped via `restaurant_id`. Quantities are stored as
  integer **milliunits** (a real quantity × 1000, i.e. 3 decimal places of precision)
  rather than floats or Postgres `NUMERIC` — the exact same "integers only" reasoning
  `src/lib/money.ts` already established for paisa, applied to physical quantities
  instead of currency, and deliberately kept consistent with that existing pattern
  rather than introducing a second precision-handling approach. `inventory_items.
  currentStockMilliunits` and `costPerUnitInPaisa` are **cached/derived** values,
  recomputed by `src/lib/inventory.ts` every time a purchase, sale-deduction, or manual
  adjustment happens — never hand-edited directly. The actual source of truth is the
  `stock_movements` ledger (same ledger-over-mutable-single-field philosophy as
  `payments` from Phase 5).
- **`src/lib/quantity.ts`** — milliunit conversion/formatting helpers
  (`unitsToMilliunits`, `milliunitsToUnits`, `formatQuantity`), dependency-free, mirrors
  `money.ts`'s role. **`src/lib/inventory-units.ts`** — the fixed set of units
  (g/kg/ml/l/piece/packet/dozen), also dependency-free, shared unmodified between
  validation, API routes, and the dashboard UI.
- **`src/lib/inventory.ts`** — the ledger choke point. `recordStockMovement()` inserts a
  `stock_movements` row and atomically increments the cached stock in the *same SQL
  statement* (`currentStock += delta`, not a read-then-write in JS), so two concurrent
  movements against the same item can't race and silently drop one. `applyPurchaseCosting()`
  recomputes a weighted-average cost-per-unit on every purchase — a single unusually
  expensive or cheap restock doesn't instantly become the item's entire cost basis for
  margin calculations — clamping existing negative stock to 0 for the cost-basis
  calculation only (stock itself is still allowed to go negative; see "Known gaps").
  `deductRecipeStockForOrder()` fans a single order's line items out across each item's
  recipe and deducts the right multiples, skipping order lines with no `menuItemId` (the
  menu item was deleted since the order was placed) or no recipe defined (recipes are
  opt-in, not a hard requirement to take an order).
- **Recipe-driven deduction is wired into the order status route**
  (`.../orders/[orderId]/status/route.ts`): stock is deducted exactly once, at
  `confirmed → preparing`, inside the same DB transaction as the status update itself —
  if the deduction fails, the status change rolls back too, so an order can never
  silently advance with stock left un-deducted. Idempotency is free: the order-status
  state machine's single-direction guarantee (no back-edges — `preparing` can never
  transition back to `confirmed`) means this specific transition can only ever fire once
  per order, so no separate "already deducted" flag was needed — the same insight the
  KDS phase used for its own idempotency question.
- **`hasPermission()`** added to `src/lib/rbac/guard.ts` — a non-throwing permission
  check, for routes that need to *adjust what comes back* based on a permission (e.g.
  including recipe cost fields only for someone with `VIEW_PROFIT`) rather than
  rejecting the whole request when they don't have it. `requirePermission()`/
  `requireAnyPermission()` remain the right choice whenever the answer is "reject the
  request."
- **API routes**, all gated behind `MANAGE_INVENTORY` for both reads and writes —
  unlike the menu subsystem's GET-open/write-gated split, ingredient/supply-chain data
  is treated as more sensitive than menu availability and isn't exposed to waiters/
  cashiers/kitchen staff by default:
  - `suppliers/` (GET/POST) + `suppliers/[supplierId]` (PATCH, soft-deactivate only)
  - `inventory-items/` (GET/POST, GET includes a derived `isLowStock` flag recomputed
    fresh on every read so it can never drift) + `inventory-items/[itemId]` (PATCH)
  - `inventory-items/[itemId]/adjustments/` (GET for the movement-history ledger, POST
    for manual add/remove adjustments with a mandatory reason)
  - `purchases/` (GET/POST — one purchase can span multiple line items; the whole thing
    — header, line items, each item's recomputed cost, each stock-movement ledger entry
    — commits atomically in a single transaction)
  - `menu-items/[itemId]/recipe` (GET/PUT — full-replace semantics, not incremental
    add/remove; GET conditionally includes cost fields based on `VIEW_PROFIT` via the
    new `hasPermission()` helper — forward-looking for custom role permissions, since
    every role with `MANAGE_INVENTORY` also has `VIEW_PROFIT` in the current default
    matrix, so this split has no visible effect yet)
- **Inventory dashboard UI** (`/dashboard/inventory`, `InventoryBoard.tsx`) — four tabs:
  Items (stock levels, low-stock badges, cost/unit, adjust-stock modal), Suppliers,
  Purchases (multi-line purchase form + history), and Recipes (per-menu-item ingredient
  editor with live cost-per-serving). `apiPut` added to `src/lib/api-client.ts` for the
  recipe route's full-replace `PUT`.
- **119 → 148 automated tests passing** (+11 pure `quantity.ts`/`inventory.ts`
  (`isLowStock`) unit tests, +9 Zod schema tests for the milliunit/paisa transform
  contracts, +9 DB-backed integration tests covering tenant isolation at the ledger
  layer, the weighted-average costing formula against hand-computed values, and
  recipe-driven deduction with skip-on-no-recipe behavior). `tsc --noEmit`, `eslint`,
  and `next build` all clean.
- **End-to-end verified over real HTTP** via `scripts/smoke-test-phase7.sh` (20
  assertions, all passing): created a supplier and three inventory items, recorded a
  manual "opening stock" adjustment, recorded a purchase and verified both the new
  stock total and the recomputed weighted-average cost match hand-computed values,
  saved a recipe and verified its cost-per-serving is derived from live ingredient
  cost, placed a real order, advanced it `confirmed → preparing` and verified the exact
  recipe-scaled deduction landed, advanced it again (`preparing → ready`) and verified
  stock did **not** move a second time (idempotency), tripped the low-stock flag with a
  further adjustment, and confirmed a second restaurant owner gets a clean 403 reading,
  adjusting, or purchasing against the first restaurant's inventory. Also walked the
  full Inventory dashboard visually via Playwright — Items, Suppliers, Purchases, and
  Recipes tabs, plus the adjust-stock modal — screenshots delivered alongside this
  write-up.

## Known gaps / deliberately deferred

- **No unit-conversion system.** Each inventory item has exactly one fixed unit of
  measure; you cannot record a purchase in grams against an item tracked in kilograms,
  or define a recipe quantity in a different unit than the ingredient's own. A real
  kitchen sometimes buys in one unit and portions in another (e.g. a 25kg sack portioned
  in grams) — for this phase, that's handled by choosing the finer-grained unit (grams)
  for the item from the start. Full unit conversion (with a conversion-factor table) is
  a reasonable Phase 8+ follow-up if this friction turns out to matter in practice.
- **Stock is allowed to go negative and nothing blocks an order because of it.** Orders
  are still accepted and processed purely on menu availability (`isAvailable`), not on
  whether the kitchen actually has the ingredients on hand — recipe deduction can run an
  item's stock below zero with no warning at order-creation time. Low-stock badges
  (based on `reorderLevelMilliunits`) are the only signal today; a hard stock-out block
  or a strong warning at order time is a natural next step once real kitchens are using
  this and can say how disruptive false-positive blocks (e.g. from an undercounted
  ingredient) would be versus the value of the guardrail.
- **No live HTTP coverage of the inventory_manager-vs-waiter permission split.** Same
  limitation as every phase since Phase 4: there's no staff-invite endpoint yet
  (Phase 8), so the smoke test can only drive the API as the owner (who holds every
  permission). The actual enforcement — and the non-throwing `hasPermission()` helper —
  are proven directly against the seeded `role_permissions` data in
  `src/db/__tests__/inventory-permissions.test.ts` instead.
- **Purchases have no edit/void endpoint.** A purchase, once recorded, is permanent —
  correcting a mis-entered purchase today means a manual offsetting adjustment, not an
  edit to the original purchase record. This mirrors the "ledger, never mutate history"
  philosophy on purpose, but a dedicated void/correction flow (that also reverses the
  weighted-average cost impact) would be a cleaner UX than an implicit adjustment.
- **No automatic reorder suggestions or purchase-order generation.** Low stock is
  surfaced (a badge on the Items tab), but there's no "generate a draft PO for
  everything below reorder level, grouped by preferred supplier" workflow yet — a
  natural fit once suppliers are used more heavily in practice.
- **Recipe editor doesn't validate ingredient units against the recipe line's displayed
  unit changing mid-edit.** If you swap an ingredient in a recipe line, the quantity
  value carries over numerically even though the unit label next to it changes (e.g.
  0.2 "kg" becomes 0.2 "piece") — the number itself isn't reinterpreted, so a manual
  double-check is needed after swapping ingredients on an existing line. Minor UX
  papercut, not a data-integrity issue (the quantity is always interpreted in whatever
  unit the finally-selected ingredient uses).

## Next steps

1. Phase 8 (Staff, attendance, expenses, customers, reservations, loyalty) is next per
   the roadmap — and is also what unlocks live HTTP testing of the narrower inventory
   roles (`inventory_manager`) that this phase and Phase 6 both had to defer to DB-level
   integration tests for lack of a staff-invite endpoint.
2. Same standing item as every phase: run this against a real Supabase project once
   live credentials are available.
3. Push to GitHub from your machine.
