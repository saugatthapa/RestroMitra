# Phase 4 — Order engine + realtime: status notes

Scope per the product spec: a centralized order engine — every order, regardless of
where it came from, flows through one lifecycle staff can see and act on — plus
realtime updates.

## What's done and verified

- **Order status state machine** (`src/lib/order-status.ts`): `pending → confirmed →
  preparing → ready → served → completed`, with cancellation allowed any time up
  through `ready` but not after (a served order that goes wrong is a refund — Phase 5
  POS territory — not a silent status flip). Deliberately dependency-free (no
  `server-only`, no DB import) so it's shared, unmodified, between the API route and
  the dashboard UI, and trivially unit-tested on its own.
- **The engine is genuinely centralized, not QR-specific**: `orders.source` already
  distinguishes `qr_customer` (the only one Phase 3 produces) from `pos`/`waiter`
  (reserved for Phase 5) — every source ends up in the same `orders` table, moving
  through the same state machine, visible on the same board. Nothing about the status
  route or the board UI assumes a QR origin.
- **`GET /api/restaurants/[slug]/orders`** — lists orders (with items and add-ons)
  bounded to a 48-hour window and a 200-row cap rather than full pagination; this is a
  live-board feed, not a historical report (that's Phase 9). Optional `?status=` filter.
  Any staff member with restaurant access can view — same read/write split as menu GETs.
- **`PATCH /api/restaurants/[slug]/orders/[orderId]/status`** — the only place an order's
  status actually changes. Rejects illegal transitions (skipping stages, moving
  backwards, acting on a terminal order) with a clear 400 before touching the database.
  Permission split matches the seeded role matrix exactly: cancelling requires
  `CANCEL_ORDER` (manager/owner only by default), any other transition requires the
  broader `EDIT_ORDER` (also held by cashier/waiter) — checked against the *requested*
  target status, not the order's current one, so the error a caller sees matches what
  they tried to do.
- **Dashboard Orders board** (`/dashboard/orders`) — five live columns (New / Confirmed
  / Preparing / Ready / Served), each order card showing table, items, total, and time
  since placed, with one primary "advance" action and a "Cancel" action, both shown or
  hidden per the signed-in user's actual role permissions (computed server-side in
  `page.tsx` from `DEFAULT_ROLE_PERMISSIONS`, not just hidden client-side — the API
  enforces the same rule regardless of what the UI shows). A summary line below the
  board shows completed/cancelled counts for the window.
- **"Realtime" is polling** (every 5 seconds), not push-based — see Known gaps below.
  Good enough for a single-restaurant live board at this stage; explicitly flagged as
  the thing to revisit if/when order volume or staff count makes 5-second staleness
  actually matter.
- **Main dashboard stat cards are live now**: "Today's sales" (sum of `completed`
  orders' totals) and "Orders today" (count, excluding cancelled) are real aggregate
  queries against the `orders` table, not placeholders — visible proof the engine is
  doing something the moment you look at `/dashboard`.
- **Tenant isolation and permission-gating re-verified for orders specifically**:
  `src/db/__tests__/order-status-permissions.test.ts` proves an update scoped to the
  wrong restaurant's id matches zero rows against another restaurant's order, and —
  directly against the seeded `role_permissions` data, since there's no staff-invite UI
  yet to test this over HTTP — that a waiter can `EDIT_ORDER` but is denied
  `CANCEL_ORDER`, while a manager can do both.
- **69 automated tests passing** (up from 59 in Phase 3: +7 pure state-machine unit
  tests, +5 order tenant-isolation/permission integration tests). `tsc --noEmit`,
  `eslint`, and `next build` all clean.
- **End-to-end verified over real HTTP** via `scripts/smoke-test-phase4.sh` (17
  assertions, all passing): placed a real order through the public QR endpoint, drove
  it through the full `confirmed → preparing → ready → served → completed` pipeline via
  the staff API, confirmed skipping straight from `pending` to `completed` is rejected
  with 400, confirmed a completed order can't be moved again, cancelled a second order
  with a reason and confirmed it can't be un-cancelled, confirmed a nonexistent order id
  returns 404, and confirmed a second restaurant owner gets a clean 403 both listing and
  patching the first owner's orders. Also walked visually via Playwright: seeded one
  order per status column and screenshotted the live board, then completed one and
  screenshotted the dashboard's now-nonzero stat cards.

## Known gaps / deliberately deferred

- **Polling, not push-based realtime.** The spec calls out "realtime"; this phase ships
  a 5-second poll instead of WebSockets/SSE/Supabase Realtime. It works and is simple,
  but every open dashboard tab re-fetches the full order list every 5 seconds — fine at
  small scale, worth swapping for a push mechanism before this runs with many
  simultaneously-open staff devices.
- **No manual/staff order entry UI.** Staff can only work orders that arrive via QR
  (Phase 3) — there's no "add a phone order" or "walk-in" button on the Orders board.
  That's intentionally left for Phase 5 (POS), where order entry naturally comes with a
  cart-building UI anyway; building a second, throwaway cart UI here just to duplicate
  it in Phase 5 wasn't worth it. The backend is ready for it (`orders.source` already
  has `pos`/`waiter` values reserved), so Phase 5 adds a route and a UI, not a schema
  change.
- **No permission-split coverage over live HTTP for narrower roles** (waiter/cashier) —
  there's no staff-invite endpoint yet (Phase 8), so the smoke test can only drive the
  API as the owner. The actual enforcement (`requirePermission` against seeded
  `role_permissions`) is proven directly against the database instead; once Phase 8
  ships staff invites, the HTTP smoke test should be extended to log in as a waiter and
  confirm the 403 over real HTTP too.
- **No KDS ticket, no kitchen-specific view.** `kitchen_staff` role holders can't act on
  this board at all today (they hold `VIEW_KDS`/`UPDATE_KDS_STATUS`, not `EDIT_ORDER`)
  — that's by design; Phase 6 gives them their own ticket-based interface rather than
  this generic list.
- **"Today" for the dashboard stat cards is a UTC calendar day**, not the restaurant's
  own timezone (`restaurants.timezone` exists but isn't threaded through here yet).
  Fine for a live glance; worth fixing before it's used for anything commercial like
  end-of-day reconciliation (Phase 9).

## Next steps

1. Phase 5 (POS, billing, payments, split bills) is next — it's what finally gives
   staff a way to create orders themselves (walk-ins, phone orders) through the same
   engine, and turns a `completed` order into an actual paid bill.
2. Same standing item as every phase: run this against a real Supabase project once
   live credentials are available.
3. Push to GitHub from your machine.
