# Phase 6 — Kitchen Display System (KDS) + KOT: status notes

Scope per the product spec: give kitchen staff their own ticket-based view of incoming
orders, scoped to what they actually need to act on, instead of the full front-of-house
Orders board.

## What's done and verified

- **Kitchen station snapshotting on order items** (`src/db/schema.ts`, migration
  `0004_striped_doorman.sql`): `order_items` gained `kitchen_station_id` and
  `kitchen_station_name_snapshot`, populated from the menu item's *current* kitchen
  station at the moment an order is placed — exactly the same reasoning, and the same
  onDelete-set-null/traceability-only pattern, as the existing `menu_item_id`/
  `menu_item_name_snapshot` and variant snapshot columns. A station rename, reassignment,
  or deletion after an order was placed can never rewrite which kitchen an
  already-placed ticket shows up on. `computeOrderPricing()` (`src/lib/orders.ts`) now
  fetches each item's `kitchenStation` relation and both order-creation routes (public
  QR from Phase 3, staff/POS from Phase 5) persist the two new columns unchanged — no
  route had to special-case anything.
- **`src/lib/kds.ts`** — the KDS rulebook, dependency-free (no `server-only`, no DB
  import) exactly like `order-status.ts` and `payments.ts`: `KDS_VISIBLE_STATUSES`
  (`confirmed`/`preparing`/`ready` — a ticket board has nothing to show for a `pending`
  order front-of-house hasn't accepted yet, or a `served`/`completed`/`cancelled` one),
  `isKitchenTransition()` (the only two moves a kitchen ticket board itself drives:
  `confirmed -> preparing` and `preparing -> ready`), and station-grouping helpers
  (`stationForItem`, `distinctStations`, `itemsForStation`) that fall items with no
  station assigned into an "Unassigned" catch-all rather than dropping them.
- **`requireAnyPermission()`** added to `src/lib/rbac/guard.ts` — succeeds if the caller
  holds ANY ONE of a list of permissions (still fails closed: an empty list is always
  denied, never trivially satisfied). This is what makes the kitchen-driven transitions
  usable by more than one role without loosening anything else: `EDIT_ORDER` (waiter/
  cashier/manager/owner) OR the narrower `UPDATE_KDS_STATUS` (kitchen_staff) is
  sufficient for `confirmed -> preparing` / `preparing -> ready`, but every *other*
  transition on the same route — accepting a new order, serving a ready one, cancelling
  — still requires `EDIT_ORDER`/`CANCEL_ORDER` specifically. `kitchen_staff` holding
  only `UPDATE_KDS_STATUS` cannot accept, serve, or cancel an order; it can only move
  one it's already been handed forward through the two cooking stages.
- **KDS dashboard board** (`/dashboard/kds`, `KDSBoard.tsx`) — three columns (Waiting to
  start / In progress / Ready) matching the kitchen-relevant slice of the order
  lifecycle, station tabs built dynamically from whatever stations are actually present
  in today's tickets (a restaurant doesn't need to pre-configure anything to get a
  useful board), each ticket showing only that station's items when a specific station
  tab is selected (quantity, variant, add-ons, notes) with one advance action per
  ticket. Polls every 5 seconds, same as the Orders board. Ticket numbers link through
  to the full order/bill view from Phase 5.
- **96 -> 119 automated tests passing** (+15 pure `kds.ts` unit tests covering the
  transition rules and station-grouping edge cases like "Unassigned always sorts last",
  +8 DB-backed integration tests proving the `kitchen_staff`/`waiter` permission split
  against the live `role_permissions` table — including the empty-list-always-denied
  edge case and tenant isolation for the new `requireAnyPermission` — plus a real DB
  round trip proving a multi-station order's items snapshot and persist the correct
  station on each row). `tsc --noEmit`, `eslint`, and `next build` all clean.
- **End-to-end verified over real HTTP** via `scripts/smoke-test-phase6.sh` (13
  assertions, all passing): created two kitchen stations and a menu item on each, placed
  a single order spanning both stations, confirmed the order detail response shows the
  correct station snapshot per item, drove the order through
  `confirmed -> preparing -> ready`, confirmed the reverse transition
  (`ready -> preparing`) and a skip (`confirmed -> ready`) are both still rejected with
  400 after the permission-check rewrite, and confirmed a second restaurant owner still
  gets a clean 403 on the (now-rewritten) status route. Also walked the KDS board
  visually via Playwright: seeded three tickets across the Grill and Bar stations in
  different stages, screenshotted the all-stations view, filtered to Grill only and
  confirmed the Bar item disappears from the ticket, then advanced a ticket live and
  screenshotted it moving from "Waiting to start" to "In progress" — screenshots
  delivered alongside this write-up.

## Known gaps / deliberately deferred

- **Order status stays order-level, not per-station.** This is the central tradeoff of
  this phase's design: an order spanning two stations (e.g. a sizzler from the Grill and
  a lassi from the Bar) has ONE status. If the Grill marks the whole order `ready` while
  the Bar hasn't actually finished the lassi yet, the order shows as `ready`
  everywhere — including on the Bar's own filtered ticket view — even though the Bar's
  item isn't done. For small single-station-dominant kitchens (most momo shops, cafes,
  and bars in scope for this build) this is rarely an issue in practice; a restaurant
  running multiple busy stations on every order would want true per-item prep tracking,
  which needs its own status column on `order_items` and is a bigger schema/UI
  change — flagged here rather than silently built halfway.
- **No live HTTP coverage of the kitchen_staff-vs-waiter permission split.** Same
  limitation as every phase since Phase 4: there's no staff-invite endpoint yet
  (Phase 8), so the smoke test can only drive the API as the owner (who holds every
  permission). The actual enforcement is proven directly against the seeded
  `role_permissions` data in `src/db/__tests__/kds-permissions.test.ts` instead.
- **No printed KOT.** The KDS board is a live screen, not a printed kitchen ticket —
  restaurants that want a physical slip per order still rely on staff reading the
  screen or the printable bill view from Phase 5. Dedicated KOT printing (thermal or
  otherwise) is Phase 11 territory (payment/hardware integrations) per the roadmap.
- **Stations shown are derived from today's orders, not the full configured list.** A
  station with zero current tickets doesn't get a tab — reasonable for "what needs my
  attention right now," less useful if a manager wants to confirm a station exists at
  all with nothing in it. Worth reconsidering if stations end up being configured but
  sitting idle for stretches.
- **No prep-time/SLA indicators.** Menu items already carry `prepTimeMinutes` (from
  Phase 2) but the KDS board doesn't use it yet — no "this ticket is running late"
  highlighting. Natural follow-up once real kitchens are using this and can say what
  threshold actually matters to them.

## Next steps

1. Phase 7 (Inventory, recipes, suppliers, purchases) is next per the roadmap.
2. Same standing item as every phase: run this against a real Supabase project once
   live credentials are available.
3. Push to GitHub from your machine.
