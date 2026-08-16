# Phase 3 — Tables + QR ordering: status notes

Scope per the product spec: tables, QR code generation, and customers being able to
scan a table's code to browse the menu and place an order — no app install, no login.

## What's done and verified

- **Schema**: `restaurant_tables` (one per physical table, carries a high-entropy
  `qr_token`), `orders`, `order_items`, `order_item_addons`. Every price on an order is
  a **snapshot** taken at submission time (name + price copied from the menu row), not
  a live reference — a bill for an order placed yesterday keeps showing yesterday's
  price even if today's menu has changed. See `src/db/schema.ts` comments for the full
  reasoning, including why `orders.status` already has the full future lifecycle
  (`confirmed`/`preparing`/.../`cancelled`) even though this phase only ever creates
  `pending` orders — that's Phase 4/5/6 territory (order engine, POS, KDS).
- **QR codes**: `src/lib/qr.ts` generates a 32-byte random, URL-safe token per table
  (`generateQrToken`) and renders it as a PNG (`qrcode` package) on demand via
  `GET /api/restaurants/[slug]/tables/[tableId]/qr`. The token — not the table id — is
  the only thing that resolves a table on the public order page; it's never
  sequential/derivable, so a customer at table 3 can't guess table 4's link.
- **Server-side price computation, not client-trusted**: `src/lib/orders.ts`'s
  `computeOrderPricing()` is the single choke point the public order-submission
  endpoint relies on. It takes a cart shape that has **no price field at all** —
  `{menuItemId, variantId?, quantity, addonIds?}` — so there's nothing for a client to
  even attempt to tamper with; every unit price, addon price, and tax rate is looked up
  fresh from the database, scoped to the resolved restaurant. Verified directly (see
  Tests below) and by live HTTP smoke test: a request that adds an unrecognized `price`
  field to the payload has zero effect on the computed total.
- **Full CRUD for tables**, RBAC-protected via the existing `manage_tables` permission
  (already in the Phase 1 permission catalog, seeded to owner/manager) and
  tenant-scoped through `resolveRestaurantContext()`: create (defaults to the
  restaurant's main branch), rename/update capacity, soft-deactivate. QR image fetch is
  a read, available to any staff member with restaurant access, not just
  `manage_tables` holders — matches the read/write split used for menu GETs vs POSTs.
- **Public, unauthenticated ordering flow**:
  - `GET /order/[token]` (`src/app/order/[token]/page.tsx`) — server-rendered, resolves
    the table + restaurant + currently-available menu directly from the token, with no
    session involved anywhere. Shows a friendly "table unavailable" message (not a raw
    error) if the table or restaurant has been deactivated.
  - `POST /api/order/[token]` — validates the cart with Zod, recomputes pricing
    server-side, and writes the order + order items + addons in a single DB
    transaction. Order numbers (`YYYYMMDD-XXXX`) are generated with a
    retry-on-unique-violation loop against a `(restaurant_id, order_number)` unique
    index, so the guarantee is the DB constraint, not just the randomness.
  - Rate limited by both IP and by table/token (`src/lib/rate-limit.ts`, same in-memory
    caveat as auth endpoints — see that file's own doc comment) since this is the most
    abuse-prone route in the app so far: open to the internet, no login required.
  - CSRF defense-in-depth (`x-dhankipos-client` header) still applies even though
    there's no session to protect, for consistency and because it costs nothing.
- **Mobile-first customer UI** (`PublicOrderMenu.tsx`): category tabs, item cards,
  a variant/add-on "customize" modal with a live local price preview, a cart view, and
  a checkout form (name/phone/notes all optional — no forced account creation) ending
  in an order-number confirmation screen.
- **Dashboard UI**: `/dashboard/tables` — table cards showing seats, an inline QR code
  image, download/copy-link/rename/deactivate actions. "Tables & QR" is now enabled in
  the sidebar; the dashboard roadmap and stat cards reflect Phase 3 being live.
- **Tenant isolation re-verified for every new table**, not assumed to inherit earlier
  phases' guarantees: `src/db/__tests__/tables-tenant-isolation.test.ts` proves an
  update scoped to restaurant B's id matches zero rows against restaurant A's table,
  that qr_token lookups only ever resolve to the one table they belong to, and that the
  token itself doesn't embed the table/restaurant id.
- **Pricing correctness re-verified against a real database**:
  `src/db/__tests__/order-pricing.test.ts` covers base-price items, variant-required
  items (and rejects ordering one without a variant, or with a variant that belongs to
  a *different* item), addon totals multiplied correctly by quantity, per-line tax,
  quantity bounds (1–50), an item belonging to a different restaurant entirely (proves
  the DB query is actually scoped, not filtered client-side), and multi-line subtotal
  aggregation.
- **59 automated tests passing** (up from 38 in Phase 2: +11 table tenant-isolation, +14
  order-pricing, threaded through a small shared refactor — `AuthError` now extends a
  new shared `HttpError` base class so `OrderValidationError` can reuse the same
  `toErrorResponse()` conversion path). `tsc --noEmit`, `eslint`, and `next build` all
  clean.
- **End-to-end verified over real HTTP** against the local dev database via
  `scripts/smoke-test-phase3.sh` (18 assertions, all passing): register → onboard →
  build a menu item with a variant and an addon → create a table → fetch its QR PNG →
  load the public order page and confirm it shows the right restaurant/table → submit a
  real order and confirm the server-computed total is exactly correct (Rs. 180 × 2 +
  Rs. 20 addon × 2, +13% tax = Rs. 452.00) → confirm a payload with a smuggled `price`
  field produces the *same* correct total, not the tampered one → confirm an invalid
  menu item id is rejected with 400 → confirm the rate limiter trips after repeated
  submissions → confirm a second owner gets a clean 403 trying to list or edit the
  first owner's tables by slug. Also walked visually via Playwright screenshots of both
  the staff side (tables list, QR code) and the customer side (menu → customize item →
  cart → checkout → confirmation) on a phone-sized viewport.

## Known gaps / deliberately deferred

- **Orders created here go nowhere yet.** They land in the database as `status: pending`
  and that's it — there's no staff-facing view of incoming orders, no way to confirm/
  reject one, no KDS ticket. That's exactly Phase 4 (order engine) and Phase 6 (KDS);
  building it now would mean redoing it once those phases define the real state
  machine. The dashboard's "Orders today" stat card still reads 0 for the same reason.
- **No live status for the customer either** — after placing an order, the confirmation
  screen is static ("show this to staff"), not a live-updating ticket. Realtime order
  status is explicitly Phase 4 territory (the spec calls out "order engine + realtime").
- **Menu is still restaurant-wide, not per-branch** (inherited from Phase 2), and a
  table belongs to exactly one branch — fine for the single-branch restaurants Phase 1
  onboarding creates; per-branch menus are Phase 11 (multi-branch).
- **Table creation UI has no branch picker** — it silently uses the restaurant's main
  branch, which is the only one that exists until Phase 11. The API already accepts an
  explicit `branchId` and validates ownership if one is sent, so the UI-side picker is a
  frontend-only addition later, not a backend change.
- **Rate limiting is in-memory and IP-keyed**, same caveat as Phase 1's auth endpoints
  (`src/lib/rate-limit.ts`): single-process only, and if a deployment sits behind a
  reverse proxy that doesn't set `X-Forwarded-For`, all traffic collapses into one
  "unknown" bucket. Needs a shared store (Redis/Upstash) plus confirmed proxy headers
  before this handles real internet traffic at scale.
- **No payment step** — by design. QR ordering here produces a pending order for staff
  to see and act on (once Phase 4 gives them somewhere to see it); payment collection is
  Phase 5 (POS, billing).

## Next steps

1. Phase 4 (centralized order engine) is next per the roadmap: give staff a live view
   of orders landing from this phase's QR flow (and, later, POS/waiter-entered orders
   too), with real status transitions or `pending → confirmed → preparing → ...`.
2. Same standing item as every phase: run this against a real Supabase project once
   live credentials are available — so far every phase has only been proven against
   local Postgres in the build sandbox (or the user's own local dev database).
3. Push to GitHub from your machine.
