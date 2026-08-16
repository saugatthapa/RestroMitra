# Phase 8 (part 2) — Customers (CRM) + Loyalty program: status notes

Continuing the Phase 8 roadmap item ("Staff, attendance, expenses, customers,
reservations, loyalty") — [Phase 8 part 1](./PHASE_8_NOTES.md) covered staff
management and attendance; this slice covers **customer CRM** and a **tiered loyalty
program**, end to end (schema, API, UI, tests, live smoke test, screenshots).
Expenses and reservations are still next; see "Next steps."

## Competitive context

Per the standing instruction to build something better than existing Nepal
restaurant-SaaS competitors (e.g. restrohub.com.np): their loyalty offering is a
tiered points program (Bronze/Silver/Gold/Platinum-style) with "streaks." This phase
matches the tier structure directly, and makes one deliberate improvement: tiers here
are driven by **lifetime points earned**, not the current spendable balance — a
customer who redeems points for a reward doesn't get demoted the same visit. A
points balance that resets your status every time you spend it isn't much of a
"status" at all. Points-earning streaks (e.g. bonus points for consecutive weekly
visits) are noted as a follow-up in "Known gaps" rather than silently skipped.

## What's done and verified

- **Schema** (`src/db/schema.ts`, migration `0007_striped_leo.sql`): two new tables.
  `customers` (`restaurantId`, `phone`, `fullName`, `email`, `notes`,
  `loyaltyPointsBalance`, `lifetimePointsEarned`, `totalOrdersCount`,
  `totalSpentInPaisa`, `isActive`) with a unique index on `(restaurantId, phone)` —
  the same phone can be a separate customer record at a different restaurant, but
  not twice at the same one. `loyalty_transactions` (`restaurantId`, `customerId`,
  `type` — earn/redeem/adjustment —, signed `pointsDelta`, `referenceType`/
  `referenceId`, `note`, `recordedByUserId`) is the ledger of record; the four cached
  fields on `customers` are recomputed via atomic in-place SQL increments, never
  hand-edited — the same "ledger over mutable single field" pattern used for
  `payments`/`stock_movements`/`attendance_records`, now used a third time. `orders`
  gained a nullable `customerId` (set-null on delete), currently only settable via
  staff/POS order creation (the public QR flow doesn't ask "who are you" yet).
- **`src/lib/loyalty-tiers.ts`** — pure, dependency-free tier math (`tierForPoints`,
  `pointsToNextTier`), same pattern as `order-status.ts`/`attendance.ts`. Four fixed
  platform-wide tiers: Bronze (0), Silver (500), Gold (1500), Platinum (3000 lifetime
  points).
- **`src/lib/loyalty.ts`** (`server-only`) — `computePointsEarned` (1 point per Rs 10
  spent, floored), `recordLoyaltyTransaction` (the single choke point for any balance
  change — inserts the ledger row and atomically updates the cached balance/lifetime
  fields in the same SQL statement, throws `LoyaltyError` if the customer doesn't
  belong to the given restaurant), and `recordOrderCompletionLoyalty` (called once per
  order — see below).
- **Loyalty award wired into the order lifecycle**
  (`.../orders/[orderId]/status/route.ts`): the `->completed` transition — served's
  only forward edge, and a terminal state with no way back — atomically awards points
  and rolls the order into the customer's lifetime stats, in the same transaction as
  the status update. Idempotency is free for the same reason Phase 7's recipe stock
  deduction gets it for free: the order-status state machine can't re-fire a
  transition into `completed` a second time, so there's no separate "already
  processed" flag to maintain. An order with a total that rounds down to 0 points
  still updates `totalOrdersCount`/`totalSpentInPaisa` (those aren't points-gated).
- **Customer linking on staff/POS orders** (`.../orders/route.ts`): an optional
  `customerId` is verified server-side against the restaurant before being attached
  to the order — same "resolve, don't trust" pattern already used for `tableId` in
  that same route. A `customerId` from another restaurant is rejected with 404.
- **Customers API** (`.../customers/`, `.../customers/[customerId]/`,
  `.../customers/[customerId]/loyalty/adjust/`), gated behind a new `MANAGE_CUSTOMERS`
  permission (already in the catalog since Phase 1, granted to manager+cashier by
  default — no new permission needed, no catalog change required):
  - `GET /customers` — search-filterable list (`?q=` matches phone or name).
  - `POST /customers` — creates a customer; refuses a duplicate phone at the same
    restaurant with 409.
  - `GET /customers/[id]` — detail view: the customer record, recent order history,
    and the loyalty ledger, in one call.
  - `PATCH /customers/[id]` — profile edits and soft-delete (`isActive`) — loyalty
    balances are deliberately NOT editable here, only through the ledger.
  - `POST /customers/[id]/loyalty/adjust` — manual point add/redeem. A "redeem"
    reduces the balance and is refused (400) if it would go negative. An "add" is
    recorded as type `adjustment` (not `earn`) so a goodwill credit does **not** bump
    lifetime points/tier standing — only money actually spent should move someone up
    a tier.
- **Customers dashboard UI** (`/dashboard/customers`, `CustomersBoard.tsx`) — a
  search/list view with a tier badge per row, an add-customer form, and a detail
  view showing points balance, lifetime points, order count, total spent, a tier
  badge with "N points to next tier," recent order history, the loyalty ledger, and
  an adjust-points form. "Customers" enabled in the dashboard nav.
- **Tests**: `src/lib/loyalty-tiers.test.ts` (tier boundaries, no-demotion-on-
  balance guarantee), `src/lib/validation/customers.test.ts` (schema edge cases),
  `src/db/__tests__/customers-loyalty-permissions.test.ts` — proves the
  `MANAGE_CUSTOMERS` permission split (manager/cashier yes, waiter/kitchen_staff/
  inventory_manager no), tenant isolation, `recordLoyaltyTransaction`'s cross-tenant
  defense (throws for a customerId belonging to another restaurant), the points
  math and cached-field bookkeeping for `recordOrderCompletionLoyalty` against a real
  Postgres instance, and that a manual redemption reduces balance without touching
  lifetime points. 200 tests total after this phase (up from 173).
- **Live smoke test** (`scripts/smoke-test-phase8b.sh`, 29 assertions, all passing):
  customer creation + duplicate-phone 409, the `MANAGE_CUSTOMERS` split over real
  HTTP (waiter 403, cashier/manager 200), a POS order linked to a customer via
  `customerId`, a cross-restaurant `customerId` rejected with 404, the order driven
  all the way from `pending` to `completed` with points correctly awarded (Rs 500 →
  50 points) and lifetime/order-count/total-spent all verified, manual redemption
  (including over-redemption correctly refused with 400), a goodwill credit
  confirmed NOT to move lifetime points, a second completed order pushing lifetime
  points across the Silver threshold, and cross-tenant isolation on the customer
  detail route (403 for an unrelated owner).
- **Playwright screenshots** (`scripts/screenshot-phase8b.mjs`) — seeded three
  customers at Bronze/Silver/Gold tiers via real completed orders (all entity names
  prefixed `Phase8bTour` for reliable cleanup, learned the hard way in Phase 8a —
  see that phase's notes), captured and visually verified: the customer list with
  its tier badges, the Gold customer's detail view (points, tier, "points to next
  tier," order history, mixed earn/adjustment ledger), the adjust-points form, and
  the add-customer form.

## Known gaps / deliberately deferred

- **No customer picker in the POS order builder UI.** The underlying mechanism
  (`customerId` on staff order creation, points awarded on completion) is fully
  built and smoke-tested via direct API calls, but `POSOrderBuilder.tsx` doesn't yet
  have a "search/select a customer" step wired in — today a customer can only be
  attached to an order by a caller that already knows the customer's id (e.g. a
  future receipt lookup flow, or directly via the API). Deferred rather than making
  an already-complex existing component larger in this slice; picking a customer by
  phone lookup mid-order is a natural next addition to that component.
  Instead see the QR customer-facing route below and the API tests.
- **The public QR ordering flow doesn't ask "who are you."** Only staff/POS-created
  orders can carry a `customerId` today. A customer scanning a table QR code and
  ordering themselves has no way to identify themselves and earn points on that
  order. A natural fit once there's a lightweight customer-facing "enter your phone
  for points" step — likely paired with the missing POS picker above.
- **No loyalty-earning streaks.** RestroHub's loyalty program includes visit-streak
  bonuses; this phase's earning model is flat (1 point per Rs 10 spent, always).
  Streaks add real engagement value but also real complexity (defining what breaks a
  streak, timezone edge cases on "day"); deferred to a dedicated slice once the core
  ledger/tier mechanics (this phase) are proven in production.
- **Tier thresholds are a fixed, platform-wide MVP default**, not configurable per
  restaurant. A high-volume restaurant and a small cafe likely want different
  thresholds for what counts as their best customers. Deferred rather than
  half-building a settings UI for it; `loyalty-tiers.ts` is written so the four
  thresholds are the only thing that would need to become restaurant-scoped data
  later.
- **No redemption "catalog"** (e.g. "200 points = a free momo plate"). Points can be
  manually redeemed for an arbitrary amount with a free-text reason today, which
  covers the MVP case (a cashier honoring a reward at their discretion) but isn't a
  structured rewards menu a customer could see themselves. Natural follow-up once
  there's a customer-facing surface (e.g. an SMS/order-receipt balance check) to show
  it on.
- **No SMS/email notifications** ("You earned 50 points!", "You're now Gold tier!").
  Everything here is dashboard-visible to staff only; no customer-facing
  notification channel exists yet in this codebase.

## Next steps

1. Continue Phase 8: **expenses**, then **reservations** — the remaining two pieces
   of the Phase 8 roadmap item.
2. Wire a customer picker into `POSOrderBuilder.tsx` and/or the public QR flow, so
   loyalty points can actually be earned from the ordering surfaces staff and
   customers use day to day, not just via direct API calls.
3. Consider a redemption catalog and SMS notifications as the natural "make the
   loyalty program customer-visible" follow-up once the core mechanics have real
   usage behind them.
4. Same standing item as every phase: run this against a real Supabase project once
   live credentials are available.
5. Push to GitHub from your machine.
