# Phase 2 — Menu: status notes

Scope per the product spec: categories, menu items, variants, add-ons, availability.

## What's done and verified

- **Schema**: `kitchen_stations`, `categories`, `menu_items`, `menu_variants`,
  `menu_addons`. Menu is restaurant-level (shared across branches) for now — see
  `src/db/schema.ts` comments for why, and how per-branch overrides could be layered
  on later without a rewrite.
- **Money handling**: every price/tax field is an integer (paisa / basis points),
  never a float. `src/lib/money.ts` is the only place conversion/formatting happens.
  Tested explicitly for the classic `0.1 + 0.2 !== 0.3` float trap in
  `src/lib/money.test.ts` — paisa arithmetic doesn't have that problem.
- **Full CRUD API**, all RBAC-protected and tenant-scoped through
  `resolveRestaurantContext()` (built on Phase 1's `requireRestaurantBySlug`):
  categories (list/create/update/deactivate/reorder), kitchen stations
  (list/create), menu items (list-with-variants-and-addons/create/update/deactivate/
  reorder-within-category), variants and add-ons (create/update/deactivate, nested
  under a menu item).
- **Permission split enforced, not just documented**: `edit_menu` covers structural
  changes; changing a `price` field specifically additionally requires `edit_price`.
  Per the default role matrix, a `manager` has `edit_menu` but not `edit_price` — so a
  manager can restructure the menu (categories, descriptions, availability) but
  cannot change what anything costs. Verified in `src/lib/rbac/permissions.test.ts`.
- **Soft deletes throughout**: deactivating a category cascades to deactivate its
  items (so nothing goes on selling from a "deleted" category); nothing is
  hard-deleted, consistent with the product principle of not destroying business
  data.
- **Tenant isolation re-verified for the new tables**, not just assumed to inherit
  Phase 1's guarantees: `src/db/__tests__/menu-tenant-isolation.test.ts` proves that
  an update scoped to restaurant B's id matches **zero rows** against restaurant A's
  category/menu item (the exact mechanism every PATCH/DELETE route relies on), and
  that list queries never leak across the boundary.
- **Dashboard UI**: `/dashboard/menu` — category strip with add/rename/reorder/
  deactivate, item cards per category with an add/edit modal (name, category, kitchen
  station, description, image URL, SKU, prep time, price, tax %), inline
  variant/add-on management, and an availability checkbox. Price fields hide
  themselves for a signed-in user without `edit_price` (a UX nicety — the API is the
  actual enforcement point regardless of what the UI shows).
- **End-to-end verified over real HTTP** against the local dev database: registered
  two separate owners with two separate restaurants, built out a full MOMO category
  → Buff Momo item → Large variant → Extra spicy add-on chain for one, confirmed the
  price/tax paisa conversion was exact (Rs. 180 → 18000 paisa, 13% → 1300 basis
  points), confirmed category reorder persists, confirmed deactivating a category
  cascades to its items, and confirmed the second owner gets a clean 403 trying to
  touch the first restaurant by slug and a clean 404 (not a data leak) trying to hit
  the first restaurant's menu item id through their own restaurant's slug.
- 38 automated tests passing (up from 26 in Phase 1: +7 money-handling unit tests,
  +6 menu tenant-isolation integration tests, minus none). `tsc --noEmit`, `eslint`,
  and `next build` all clean.

## Known gaps / deliberately deferred

- **No real image upload** — `imageUrl` accepts any HTTPS URL for now. Proper upload
  (e.g. to Supabase Storage) needs object storage wiring; deferred rather than
  half-built with a fake local-disk upload that wouldn't survive a redeploy anyway.
- **Reordering is click-based (move left/right), not drag-and-drop.** The spec asks
  for drag-and-drop; the API (`/reorder` endpoints taking an ordered id array) already
  supports whatever UI drives it, so swapping in real HTML5 drag-and-drop later is a
  frontend-only change, not a backend one. Kept simple for now to stay in scope for
  one phase.
- **No recipe/ingredient linkage yet** — menu items don't reference a recipe. That's
  explicitly Phase 7 (inventory/recipes) per the phase plan; adding a nullable
  `recipeId` now, before the `recipes` table exists, would just be a forward
  reference to nothing.
- **Menu is restaurant-wide, not per-branch.** Fine for a single-branch restaurant
  (which is all Phase 1 onboarding creates so far); per-branch menu overrides are a
  layer that can be added later (see schema comment) once multi-branch work
  (Phase 11 per the original spec, though it may make sense to pull earlier) starts.

## Next steps

1. Same as Phase 1: run this against your real Supabase project once you share
   connection details (`npm run db:migrate && npm run db:seed`), since so far both
   phases have only been proven against local Postgres in the build sandbox.
2. Push to GitHub from your machine.
3. Phase 3 (tables + QR ordering) builds directly on this menu system — customers
   will browse exactly what's built here.
