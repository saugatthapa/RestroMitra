# Phase 8 (part 4) — Reservations: status notes

The last piece of the Phase 8 roadmap item ("Staff, attendance, expenses, customers,
reservations, loyalty") — [part 1](./PHASE_8_NOTES.md) covered staff + attendance,
[part 2](./PHASE_8b_NOTES.md) covered customers + loyalty, [part 3](./PHASE_8c_NOTES.md)
covered expenses. This slice covers **reservations**, end to end (schema, API, UI,
tests, live smoke test, screenshots) — **Phase 8 is now fully complete.**

## Competitive context

Per the standing instruction to build something better than existing Nepal
restaurant-SaaS competitors (e.g. restrohub.com.np): their reservations offering is
drag-and-drop, calendar-style table assignment. This phase ships the core mechanic —
a real state-machine-backed booking lifecycle, table linking, and a day-scoped list
view — while deliberately deferring the visual drag-and-drop floor-plan UI (see
"Known gaps"), since the underlying data model and API are the harder, higher-risk
part to get right, and a calendar/drag UI can be layered on top of a correct backend
later without a schema change.

## What's done and verified

- **Schema** (`src/db/schema.ts`, migration `0009_quiet_salo.sql`): one new table,
  `reservations` (`restaurantId`, optional `customerId` CRM link, `customerName`/
  `customerPhone` captured directly so the booking stays readable even if the linked
  customer is later deactivated, `partySize`, optional `tableId`, `reservationTime`,
  `durationMinutes` default 90, `status`, `notes`, `createdByUserId`). Status moves
  through a one-directional state machine — `requested → confirmed → seated →
  completed`, with `cancelled` reachable from `requested`/`confirmed` (not after
  seating) and `no_show` reachable only from `confirmed` (an unconfirmed request
  that never gets a reply was never a firm booking to miss) — same "state machine,
  not a mutable free-text status" pattern as `orders`.
- **`src/lib/reservation-status.ts`** — pure, dependency-free state machine
  (`canTransition`, `nextStatuses`, `isTerminalStatus`), directly mirroring
  `order-status.ts`'s shape so it's immediately familiar to anyone who's read that
  module.
- **`MANAGE_RESERVATIONS`** (already existed in the permission catalog since Phase 1,
  unused until now) is granted to **manager + cashier + owner** by default — this
  phase added the **cashier** grant specifically, reasoning that reservations are a
  front-desk task (answering the phone, walk-ins asking to book ahead), the same
  trust level as `MANAGE_CUSTOMERS` (which cashier already held), not
  profit-sensitive the way `MANAGE_EXPENSES` is. Waiter/kitchen_staff/
  inventory_manager remain without it. Re-ran `npm run db:seed` after the catalog
  change, same operational step Phase 8c's `MANAGE_EXPENSES` addition required.
- **Reservations API** (`.../reservations/`, `.../reservations/[id]/`,
  `.../reservations/[id]/status/`), gated behind `MANAGE_RESERVATIONS` for both
  reads and writes:
  - `GET /reservations` — `?date=YYYY-MM-DD` scopes the list to that single calendar
    day (the natural unit for a reservation book — defaults to today when omitted);
    `?status=` narrows further.
  - `POST /reservations` — creates a booking; an optional `customerId`/`tableId` is
    verified server-side to belong to the restaurant before being attached, same
    "resolve, don't trust" pattern as `tableId` on staff orders and `customerId` on
    the customers/loyalty routes.
  - `PATCH /reservations/[id]` — edits booking details (party size, time, table
    assignment, notes, the captured name/phone) — everything EXCEPT status.
  - `PATCH /reservations/[id]/status` — the single choke point for status changes,
    checked against `canTransition()` so an illegal jump (e.g. `requested` straight
    to `seated`, or reopening a `no_show`) is rejected with a clear 400. Splitting
    status out from the general edit route is the same design already used for
    orders (`.../orders/[id]/status/` vs `.../orders/[id]/`).
- **Reservations dashboard UI** (`/dashboard/reservations`, `ReservationsBoard.tsx`)
  — a date picker (defaults to today), a day-scoped list with status badges and the
  legal next-action buttons per row (only the transitions `canTransition` actually
  allows for that reservation's current status are shown), an add-reservation form
  with a table dropdown pulled from the existing tables API, and inline editing.
  "Reservations" enabled in the dashboard nav — **all of Phase 8's dashboard sections
  are now live: Staff, Customers, Expenses, Reservations.**
- **Tests**: `src/lib/reservation-status.test.ts` (every transition pair checked
  against `canTransition`, terminal-status coverage), `src/lib/validation/
  reservations.test.ts` (schema edge cases including datetime coercion),
  `src/db/__tests__/reservations-permissions.test.ts` — proves the
  `MANAGE_RESERVATIONS` split (manager/cashier/owner yes, waiter no), tenant
  isolation, and a real DB round trip including the optional table link and status
  column. 235 tests total after this phase (up from 214).
- **Live smoke test** (`scripts/smoke-test-phase8d.sh`, 23 assertions, all passing):
  the permission split over real HTTP, a reservation created and linked to a real
  table, a cross-restaurant `tableId` rejected with 404, date-scoped listing (shows
  on the booked date, absent from a different date), an illegal `requested →
  seated` jump rejected with 400, the full happy path `requested → confirmed →
  seated → completed`, confirmation that `completed` is terminal, `requested →
  cancelled`, `no_show` correctly rejected from `requested` but accepted from
  `confirmed`, editing booking details via `PATCH`, and cross-tenant isolation.
- **Playwright screenshots** (`scripts/screenshot-phase8d.mjs`) — seeded three
  reservations at different statuses (requested/confirmed/seated, one with a linked
  table, all entity names prefixed `Phase8dTour`), captured and visually verified:
  the reservations list showing the status spread with per-row action buttons, and
  the new-reservation form with the table picker.

## Known gaps / deliberately deferred

- **No visual drag-and-drop floor plan.** RestroHub's reservations UI is
  calendar/drag-and-drop table assignment; this phase ships a straightforward
  date-scoped list with a table dropdown instead. The state machine and API
  underneath are the same either way — a drag-and-drop floor-plan view is a UI-only
  addition that can sit on top of this backend without a schema change, once there's
  appetite for the added front-end complexity (likely worth a dedicated calendar
  library rather than hand-rolling drag-and-drop).
- **No double-booking / table-conflict detection.** A table can be assigned to two
  overlapping reservations with no warning — `durationMinutes` exists on the row
  specifically so a future conflict check has what it needs, but the check itself
  isn't built yet. Deferred rather than half-building a warning that doesn't account
  for real seating flexibility (a party finishing early frees the table sooner than
  its estimated duration suggests).
- **No automatic order creation on "seated."** Marking a reservation seated is just
  a status flag — staff still create the actual order themselves once the party is
  seated, the same way they always have via POS/QR. Auto-creating a linked order
  would be a natural convenience addition, but reservations and orders remain
  cleanly decoupled for now (a reservation is a promise to seat someone, not itself
  a sale).
- **No SMS/call reminders.** Nothing here proactively reminds a customer of their
  booking or confirms it back to them — same "no customer-facing notification
  channel yet" gap noted in Phase 8b's loyalty notes.
- **No public-facing "book a table" page.** Reservations are staff-entered only
  (phone calls, walk-ins asking ahead) — there's no customer-self-service booking
  form analogous to the public QR ordering flow. A natural extension of the
  public-facing surface this app already has for ordering.
- **Branches aren't wired in**, same documented gap as staff/attendance
  (Phase 8 part 1) — a multi-branch restaurant sees one combined reservation book
  across all branches, not scoped per branch. Tables ARE branch-scoped already
  (inherited from the existing `restaurant_tables` schema), so the data to scope
  reservations by branch is one join away whenever this gets prioritized.

## Next steps

**Phase 8 is complete.** All six roadmap items — staff, attendance, expenses,
customers, reservations, loyalty — are built, tested, smoke-tested, and documented.

1. Move on to **Phase 9 (Analytics & reports)** — the dashboard's "Build roadmap"
   already lists this as next. A natural first cut: net expenses (Phase 8c) against
   order revenue for a profit view, surface loyalty program engagement (Phase 8b),
   and a reservations no-show rate.
2. Consider the reservations "Known gaps" above (conflict detection, auto order
   creation on seat) as candidates for a future polish pass once there's real usage
   data on which of them actually matter in practice.
3. Same standing item as every phase: run this against a real Supabase project once
   live credentials are available.
4. Push to GitHub from your machine.
