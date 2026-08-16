# Phase 12 — Table status, floor plan, and the reservation double-booking fix

Scope selected from `PLATFORM_AUDIT.md`'s P0 list: **P0 #1 (table status) +
P0 #3 (reservation double-booking prevention) + the floor plan UI**, per the
detailed spec provided. This phase deliberately did **not** touch the
existing order engine's core logic, payments/refunds, inventory, staff/RBAC,
or QR ordering's request/response shape — those were audited as already
working and are only *called into* from the new code, never rewritten.

## What was already implemented (reused, not rebuilt)

- The entire multi-tenant architecture: `resolveRestaurantContext`,
  `requireBranchAccess`, restaurant-as-tenant-root. No changes.
- The order engine and its state machine (`order-status.ts`,
  `orders/[orderId]/status/route.ts`'s compare-and-swap update) — reused
  as-is; the only change is one extra call at the end of an already-atomic
  transaction.
- The reservation state machine (`reservation-status.ts`) and its status
  route's transition checks — unchanged; only new *side effects* were added
  around the existing update.
- The reservations dashboard UI (`ReservationsBoard.tsx`) already has table
  assignment on both create and edit, and already surfaces
  `ApiError.message` from any failed request via `alert()`/inline error text.
  **No UI changes were needed there** — the new 409 "double-booking" and 400
  "capacity exceeded" errors from the backend show up automatically.
- QR ordering (`order/[token]/route.ts`) — request/response shape,
  rate limiting, and the retry-on-collision loop are untouched; two calls
  were added inside its existing transaction.
- The `.for("update")` row-lock and compare-and-swap patterns from the QA
  hardening pass were reused directly for the new table lock and the
  manual table-status route, rather than inventing a new concurrency
  strategy.
- `restaurant_tables`, `orders`, and `reservations` — no new tables were
  created. Table status/floor-plan fields were added as new *columns* on
  the existing `restaurant_tables` table (see migration below), and
  reservation double-booking prevention reads the existing `reservations`
  table — no duplicate tables/orders/reservations/customer systems.

## What was built

### Backend (Phase 12a)

- **Migration `drizzle/0015_crazy_proteus.sql`**: two new enums
  (`table_status`, `table_shape`) and eight new columns on
  `restaurant_tables` (`status`, `pos_x`, `pos_y`, `width`, `height`,
  `shape`, `rotation`, `floor_label`) plus an index on `status`. Generated
  with `drizzle-kit generate` and run with `db:migrate` — no hand-written
  SQL, no changes to any other table.
- **`src/lib/table-status.ts`** — the pure, dependency-free table state
  machine (mirrors `order-status.ts`/`reservation-status.ts`): 7 statuses
  (available, ordering, occupied, reserved, payment_pending, cleaning,
  out_of_service), `deriveTableStatus()` (order-count buckets →
  status), and `canManuallyTransition()` (the handful of staff-driven
  transitions — opening a table, finishing cleaning, marking
  broken/restored).
- **`src/lib/tables.ts`** — the DB-touching helpers, all called from
  inside an existing route's transaction (single choke point, same
  pattern as `recordStockMovement`):
  - `syncTableStatusFromOrders()` — recomputes a table's status from its
    live order counts. Skips `out_of_service` tables (manual override
    always wins) and null `tableId` (takeaway orders).
  - `assertTableAcceptsOrders()` — blocks new orders against an
    `out_of_service` table.
  - `markTableReservedIfAvailable()` / `markTableSeated()` /
    `releaseTableIfSoleReservation()` — the reservation→table lifecycle
    effects. A reservation only ever claims a table when it's currently
    `available` — it never overwrites a table a walk-in is actively using.
  - `assertNoReservationOverlap()` — the actual double-booking fix:
    interval-overlap math against requested/confirmed/seated reservations
    for that table.
  - `requireTableRowLock()` — `SELECT ... FOR UPDATE`, so two concurrent
    reservation requests for the same table serialize instead of both
    passing the overlap check.
  - `assertPartyFitsCapacity()`, `getTodayUpcomingReservationsByTable()`.
- **New route** `PATCH /api/restaurants/[slug]/tables/[tableId]/status` —
  the *only* place a staff member can directly move a table between
  available/ordering/out_of_service/cleaning-done. Every other status is
  system-derived and rejected here, so the two mechanisms can't fight.
- **New route** `GET /api/restaurants/[slug]/tables/[tableId]` — table
  detail: the table row, its active (non-completed/cancelled) orders, and
  today's upcoming reservations. Powers the floor plan's click-to-detail
  panel.
- **Wired into 6 existing routes** (each inside its own existing
  transaction, no new transactions added where one already existed):
  - `orders/route.ts` POST (staff/POS) and `order/[token]/route.ts` POST
    (QR) — `assertTableAcceptsOrders` before insert,
    `syncTableStatusFromOrders` after.
  - `orders/[orderId]/status/route.ts` PATCH — `syncTableStatusFromOrders`
    after every status transition.
  - `reservations/route.ts` POST — now wraps table resolution in a
    transaction with the row lock, capacity check, overlap check, and
    `markTableReservedIfAvailable`.
  - `reservations/[reservationId]/route.ts` PATCH — re-validates
    capacity/overlap whenever table/time/duration change, and moves the
    "reserved" flag between old/new table on a table reassignment.
  - `reservations/[reservationId]/status/route.ts` PATCH — `markTableSeated`
    on →seated, `releaseTableIfSoleReservation` on →cancelled/→no_show.
- **`src/lib/validation/tables.ts`** — `floorLabel` on create;
  `posX`/`posY`/`width`/`height`/`shape`/`rotation`/`floorLabel` on
  update; new `updateTableStatusSchema`.

### Frontend (Phase 12b/12c)

- **`FloorPlanBoard.tsx`** (new) — drag-and-drop canvas: pointer-event
  based dragging (mouse + touch, so it works on tablets), floor/section
  tabs driven by `floorLabel`, live status colors from
  `TABLE_STATUS_COLORS`, shape/rotation rendering, click-to-detail panel
  (bottom sheet on mobile, centered modal on larger screens) showing
  active orders + upcoming reservations + manual status actions + an
  "Open in POS" button.
- **`TablesView.tsx`** (new) — a thin Floor plan / List toggle so the
  existing `TablesManager.tsx` (QR codes, rename, deactivate) keeps
  working completely unchanged; the floor plan is additive.
- **`POSOrderBuilder.tsx`** (modified) — reads `?table=<id>` from the URL
  and pre-selects Dine-in + that table, so "Open in POS" from the floor
  plan lands staff directly in an order for that table. `page.tsx` wraps
  it in `<Suspense>` for `useSearchParams`.
- Overlap prevention on the floor plan is **client-side and best-effort**
  (a same-floor AABB collision check on drop, reverting the position if it
  overlaps) — per the spec's "prevent invalid overlaps *where practical*."
  It is not a server-side constraint; the update route accepts any
  position.

### Table merge/transfer

**Not built** — per the explicit instruction to design for it rather than
build it unless the architecture requires it. `orders.tableId` is already
a simple nullable FK, so a transfer endpoint is a straightforward addition
later: update `orders.tableId` for the active order(s), then call
`syncTableStatusFromOrders` on both the old and new table inside the same
transaction. No schema change would be needed.

### Customer-facing booking app backend

**Not started**, per "do not build an unrelated marketplace yet unless
required by the existing architecture." The reservations API already
exposes everything a future public booking flow would need to call
server-side (capacity, overlap, table state) — it's authenticated
staff-only today, and opening a public-facing subset of it is future work,
not part of this phase.

## Testing performed

- Full existing regression suite re-run and green: `npx vitest run` (369
  tests passing, 1 pre-existing unrelated flaky test — see below), `npx
  tsc --noEmit`, `npx eslint .`, `npx next build`, and all 15 existing
  `smoke-test-phase*.sh` scripts (3, 4, 5, 6, 7, 8, 8b, 8c, 8d, 9, 11a,
  11b, 11c, 11d) plus `qa-hardening-verify.mjs` — all pass unmodified.
- **New**: `src/lib/table-status.test.ts` — unit tests for
  `deriveTableStatus` (every bucket combination/priority) and
  `canManuallyTransition`/`manualNextStatuses`.
- **New**: `src/db/__tests__/tables-status-lifecycle.test.ts` — DB
  integration tests for `assertNoReservationOverlap` (including the
  cancelled-reservation and self-edit exclusion cases),
  `assertPartyFitsCapacity`, `syncTableStatusFromOrders` against real
  order rows, and `assertTableAcceptsOrders`.
- **New**: `scripts/smoke-test-phase12.sh` — 35 live HTTP/DB assertions:
  automatic status derivation through the full order lifecycle, manual
  transitions (legal and illegal), `out_of_service` blocking new orders,
  floor-plan layout persistence across reload, the table-detail endpoint,
  double-booking rejection (409), capacity rejection (400), edit-into-
  overlap rejection, QR ordering still flipping table status the same way
  POS does, reservation cancel/no-show releasing the table, tenant
  isolation on the two new endpoints, and — explicitly requested — the
  full **Reservation → Table → POS → Order → KDS → Payment → Table
  Available** chain end to end.
- **New**: `scripts/phase12-concurrency-verify.mjs` — genuine concurrent
  `fetch()` races (same pattern as the QA hardening pass's verify script):
  two simultaneous overlapping reservations on the same table (exactly one
  wins, 201/409), two non-overlapping ones (both succeed), and two
  simultaneous manual "open table" PATCHes (exactly one wins, 200/409).
- **New**: `scripts/phase12-screenshot-check.mjs` — live Playwright check
  of the floor plan and its detail panel at a 768px tablet width and a
  390px phone width (screenshots reviewed, both render correctly: status
  colors, shapes/rotation, floor tabs, legend, bottom-sheet detail panel
  on mobile), plus a separate check confirming "Open in POS" correctly
  hands off `?table=<id>` into a pre-filled dine-in order.

### Known gap / pre-existing flake (not caused by this phase)

`src/lib/offline-queue.test.ts`'s "lists queued orders oldest-first" test
is intermittently flaky (timestamp-ordering race, unrelated to tables/
reservations). Confirmed via `git diff` that this file was not touched in
this phase; the flake reproduces in isolation on `main` as well. Left
as-is — fixing an unrelated pre-existing flaky test was out of scope for
this phase's instructions ("implement only the missing/faulty pieces
identified by the audit").

## Remaining gaps

- **Floor plan branch scoping**: `FloorPlanBoard.tsx` currently loads all
  of a restaurant's tables via the existing (unfiltered) `GET /tables`
  call — for a multi-branch restaurant, an unrestricted owner/manager sees
  every branch's tables on one canvas with no branch filter (branch-scoped
  staff are unaffected, since the API already scopes their view). Adding a
  branch selector alongside the floor tabs would close this.
- **No UI for editing shape/size/rotation** — the schema, validation, and
  API all support it (`PATCH /tables/[id]` accepts `shape`/`width`/
  `height`/`rotation`), and new tables get sensible defaults, but the
  floor plan only exposes drag-to-reposition today. A table settings panel
  is a natural follow-up, not added this phase to keep the surface area
  focused on the P0 item (position + status).
  Overlap prevention is client-side/best-effort only, not a hard DB
  constraint — matches the spec's "where practical" wording, but two
  staff members editing positions from different devices at the same
  moment could still both land at the same spot if a save happens on
  reload before either drag; no lock protects `posX`/`posY` (mirroring
  that displacement is a cosmetic layout detail, not a business-critical
  race like a double-booking).
- **Table merge and the customer-facing booking backend**: intentionally
  not built, see above — designed for, not implemented, per explicit
  instruction.
