# RestroMitra

An all-in-one, multi-tenant restaurant management SaaS built for restaurants, cafes,
momo shops, bars, and small food businesses in Itahari, Sunsari, and Eastern Nepal.
Architecture is designed to expand nationwide.

This is an **original, independently implemented product** — it does not copy the
source code, database, branding, or private business data of any other restaurant
software. Any resemblance in *category* of feature (POS, QR ordering, KDS, etc.) is
because those are standard restaurant-software capabilities, not because anything was
copied.

## Status: Phases 1–16 done (Foundation, Menu, Tables + QR ordering, Order engine, POS + billing, KDS, Inventory, Staff + Attendance, Customers + Loyalty, Expenses, Reservations, Analytics & Reports, SaaS plans/trials/subscriptions/platform admin, Multi-branch support, Offline POS, Payment gateway integrations, AI assistant, Table status/floor plan, Discounts/service charge/tips, Groq AI, Menu item photos, Dashboard analytics polish)

Built so far: project scaffold, database schema, authentication (registration/login/
logout with hashed passwords + server-side sessions), multi-tenancy, role-based access
control (RBAC) enforced server-side, a restaurant onboarding wizard, a basic owner
dashboard shell, a full menu system (categories, items, variants, add-ons, kitchen
stations) with integer-paisa money handling and a working `/dashboard/menu` UI, tables
with QR-code ordering (staff print/download QR codes from `/dashboard/tables`, customers
scan to reach a public, no-login `/order/[token]` page and submit an order priced
entirely server-side), a centralized order engine: every order moves through a
`pending → confirmed → preparing → ready → served → completed` (or `cancelled`) state
machine, visible and actionable on a live, polling `/dashboard/orders` board, a
staff-facing POS (`/dashboard/pos`) for walk-in/phone/dine-in orders priced through the
same server-side pricing engine as QR orders, a full billing layer: an itemized bill
view per order (`/dashboard/orders/[orderId]`) with split payments across cash/card/
mobile-wallet/other, manager-level refunds, and a live-derived paid/partially-paid/unpaid
status, a Kitchen Display System (`/dashboard/kds`): live tickets grouped by kitchen
station, with kitchen staff able to advance an order through its cooking stages
(confirmed → preparing → ready) without needing the broader order-editing permission
front-of-house roles hold, full inventory management (`/dashboard/inventory`):
suppliers, tracked ingredients with integer-milliunit stock and weighted-average costing,
purchases (stock-in), a per-menu-item recipe editor with live cost-per-serving, and
automatic recipe-driven stock deduction the moment an order starts being prepared — and
staff management + attendance (`/dashboard/staff`), where an owner/manager adds staff
accounts (manager/cashier/waiter/kitchen_staff/inventory_manager), and staff clock
in/out of self-service shifts with a live roster and attendance view — and now
customer CRM + a tiered loyalty program (`/dashboard/customers`): customer records
searchable by name/phone, a Bronze/Silver/Gold/Platinum tier system driven by
lifetime points earned (so redeeming points never demotes a customer), points
automatically awarded (1 per Rs 10 spent) the moment a linked order completes, and
manual point add/redeem for staff-discretion rewards, expense tracking
(`/dashboard/expenses`): a manager/owner-gated ledger of operational spending
(rent, utilities, salaries, supplies, and more) with category/date-range filtering,
running totals per category, and in-place correction/voiding of entries — and now
reservations (`/dashboard/reservations`): table bookings taken ahead of time, moving
through a `requested → confirmed → seated → completed` state machine (with
`cancelled`/`no_show` branches), an optional link to a specific table and to a CRM
customer, and a day-scoped booking list. **Phase 8 (Staff, attendance, expenses,
customers, reservations, loyalty) is fully complete**, and now analytics & reports
(`/dashboard/reports`): a date-range-scoped dashboard (presets for Today/Last 7
days/Last 30 days/This month, plus a custom range) bundling revenue, order count,
average order value, total expenses, and net profit into KPI tiles, a hand-rolled
dependency-free SVG revenue-vs-expenses trend chart with a crosshair/tooltip hover
layer and a table-view accessibility fallback, a top-selling-items table, and
payment-method/expense-category breakdowns — all from one bundled API call so every
number on the page reflects the exact same range. Phase 9 (Analytics & reports) is
fully complete, and now the product is an actual SaaS: every restaurant starts a
real 30-day free trial at signup (logged as the first entry in an auditable
`subscription_events` ledger), a lazy self-healing check blocks dashboard/API access
the moment a trial lapses (no cron — the next request that touches an expired
restaurant does the one-time write), a top-level `/billing` page explains status and
lets an owner request a plan from a 3-tier catalog (Starter/Growth/Pro — placeholder
pricing, no payment gateway yet), staff invites are capped by the assigned plan's
seat limit, and a platform-admin-only console (`/admin`) lists every tenant and lets
an admin extend trials, assign/activate plans, mark past-due, cancel, or reactivate
any restaurant's subscription. Phase 10 (SaaS plans/trials/subscriptions/platform
admin) is fully complete, and now real multi-branch support
(`/dashboard/branches`): a restaurant can have more than one physical location, each
with its own staff (invited/reassigned with a `branchId`), tables, orders, attendance,
and reservations — enforced server-side via `requireBranchAccess` so a branch-scoped
manager can never see or act on another branch's data, an unrestricted owner/manager
sees and acts across every branch, new branches are capped by the assigned plan
(Starter: 1, Growth: 3, Pro: unlimited), and the main branch (plus the last remaining
active branch) can never be deactivated. Phase 11a (Multi-branch support) is fully
complete, and now offline-capable POS order-taking: the staff POS (`/dashboard/pos`)
tracks connectivity, caches the menu locally so it keeps rendering through an
outage, and — if a new order can't reach the server — saves it on the device
instead of erroring out, then submits it automatically the moment the connection
returns (each submission carries a client-generated id so a retried sync can never
create a duplicate order, enforced by a database-level unique constraint, not just
client-side care). Phase 11b (Offline POS) is fully complete, and now redirect-based
gateway payments: from an order's bill view, a customer-facing "Pay with a wallet"
panel starts an **eSewa** (form-POST + HMAC-SHA256-signed callback) or **Khalti**
(REST initiate + server-to-server lookup) payment for the order's remaining due
amount, both built against each gateway's public sandbox (eSewa ships with a working
default UAT key so it runs with zero setup; Khalti requires a free
test-admin.khalti.com signup, since Khalti has no shared sandbox key). A gateway
payment is never trusted from the browser redirect alone — eSewa's callback is
cryptographically verified against a secret only we and eSewa hold, and Khalti's
status is confirmed via a server-to-server lookup keyed on the pidx *we* stored, not
the query string's — and it settles into the exact same `payments` ledger as a manual
cash/card payment, so refunds/reports/billing summaries need zero gateway-specific
logic. Phase 11c (Payment gateway integrations) is fully complete, and now an AI
assistant (`/dashboard/assistant`): an owner/manager can ask plain-language questions
("how were sales last week", "what's my best-selling item") answered from the exact
same tenant-scoped sales/expense snapshot the Reports dashboard already computes — the
model is handed that data directly rather than any database access of its own, so it
cannot leak data it was never given, and it's explicitly instructed to say so rather
than guess when a question falls outside that snapshot. Requires an `ANTHROPIC_API_KEY`
(no shared sandbox key exists for an LLM API, same situation as Khalti in 11c); without
one, it fails gracefully with a clear "not configured" message instead of erroring.
**Phase 11d (AI assistant) is now fully complete** — this covers the owner/manager
analytics Q&A slice of Phase 11's AI-assistant scope; a customer-facing ordering
assistant and a staff/menu helper remain as their own, separately-scoped follow-ups.

**A pre-launch QA hardening pass is also done**, covering the two things worth
checking before real customers and real money touch this: a security/correctness
audit of the money- and auth-critical code paths (payments, refunds, gateway
callbacks, order status transitions, branch scoping — five real bugs found and
fixed, all verified live with genuine concurrent requests, not just unit tests),
and a tablet/phone responsive pass on the two screens staff actually use at the
counter or in the kitchen, POS and KDS (a critical bug — no way to navigate at all
on any screen narrower than 768px — and a KDS ticket-board cramping issue, both
fixed). See `QA_HARDENING_NOTES.md` for the full writeup.

**Phase 12 (table status + floor plan + reservation fix) is now complete** — a
`PLATFORM_AUDIT.md`-driven full-project audit against a detailed platform spec
(see the audit doc for the complete gap analysis), followed by this first P0
build: tables now carry a real, order/reservation-derived status (available →
ordering → occupied → reserved → payment_pending → cleaning → out_of_service), a
drag-and-drop floor plan (multi-floor, shapes, live status colors, click-to-detail,
tablet/phone tested) replaces guessing which table is free, reservations get real
server-side double-booking prevention and capacity checks (previously
documented-but-missing), and the full Reservation → Table → POS → Order → KDS →
Payment → Table Available chain is wired end to end and covered by a live smoke
test plus genuine-concurrency race tests. See `PHASE_12_NOTES.md` for the full
writeup, including what was reused unchanged and the remaining gaps (branch
filter on the floor plan, no shape/size editing UI yet, table merge/transfer and
the customer-facing booking backend designed for but not built).

**Phase 13 (discounts, service charge, and tips) is now complete** — the P0
item flagged in `PLATFORM_AUDIT.md` as "the single biggest POS gap for
real-world use." Orders can now carry a percentage or flat discount (with a
reason) and a service charge, both computed against the subtotal and flowing
through to the stored total, pricing/receipts, and reports; payments can
carry a tip, recorded as pure additive bookkeeping that never affects the
remaining-due calculation. A new `APPLY_DISCOUNT` permission (owner/manager,
same trust tier as refunds) gates it both at order creation and via a
dedicated whole-state adjustments endpoint for editing an existing order's
discount/service-charge after the fact. Along the way, a real pre-existing
security gap was found and fixed: the payments and refunds routes were
missing the branch-scoping check the QA hardening pass had added only to the
order-status route — verified live with a branch-scoped account. See
`PHASE_13_NOTES.md` for the full writeup, including the deliberate
tax-is-never-re-derived pricing simplification and the remaining gaps
(no restaurant-wide default service charge, no per-staff tip attribution).

**Phases 14, 15, and 16 are now complete** — requested together by the user in
one message: *"for ai i want to use groq free tier,"* *"i want it to be shown
in name and image both in card system,"* and *"i want ui better than image i
have send to you."* Phase 14 swapped the AI assistant (Phase 11d) to run on
Groq's free tier by default (`llama-3.3-70b-versatile`, chosen for its
numeric-reasoning quality on restaurant figures) via a provider-abstracted
config, while keeping Anthropic fully supported as an explicit fallback; the
request/response handling for both providers is unit-tested, and the route's
graceful-degradation-on-network-failure was verified live, but an actual
successful Groq completion could not be live-verified because this specific
build sandbox's network egress doesn't allow `api.groq.com` (same class of
limitation as `PHASE_11c_NOTES.md`'s eSewa/Khalti gap). Phase 15 added real
menu item photos everywhere an item renders as a card (menu manager, POS,
public QR ordering), with entirely client-side upload/compression (a photo is
resized and re-encoded into the existing `imageUrl` column as a small
`data:` URL — no new upload endpoint or storage infrastructure was built,
since none existed and none was asked for) — and, while verifying it with
real screenshots, caught and fixed a real layout bug where the QR menu's item
row thumbnail would blow up to fill its container instead of showing a fixed
80×80 photo. Phase 16 added peak-hour and completion-rate analytics to the
Reports page (deliberately *not* copying the dual-axis revenue/orders chart
from the reference screenshot the user sent — a dual-axis chart is this
project's own dataviz skill's #1 flagged anti-pattern), replaced the
dashboard's hardcoded "Low-stock items: 0" with a real live count, and
unified the two independently-drifted stat-tile card styles into one shared
icon-chip component used everywhere. See `PHASE_14_NOTES.md` /
`PHASE_15_NOTES.md` / `PHASE_16_NOTES.md` for the full writeups, including
every verified-live detail and remaining gap (the sandbox-network Groq
limitation, the `avgCompletionMinutes` approximation, and UTC-vs-restaurant-
timezone hour bucketing).

**A Phase 16 follow-up (16b)** added period-over-period comparison ("▲ 8.43%
vs previous period") to the Revenue/Orders/Avg-order-value/Net-profit tiles
on Reports, plus a gradient area fill under the revenue trend line — both
directly requested after the user re-shared the reference dashboard
screenshot asking for UI/UX "even better than this." The comparison is
period-length-relative (a 7-day range compares against the 7 days before it,
not a hardcoded "last calendar month"), so it stays correct for any preset
or custom range. See `PHASE_16b_NOTES.md`.

See "Build roadmap" on the dashboard for what's next, and
`PHASE_1_NOTES.md` / `PHASE_2_NOTES.md` / `PHASE_3_NOTES.md` / `PHASE_4_NOTES.md` /
`PHASE_5_NOTES.md` / `PHASE_6_NOTES.md` / `PHASE_7_NOTES.md` / `PHASE_8_NOTES.md` /
`PHASE_8b_NOTES.md` / `PHASE_8c_NOTES.md` / `PHASE_8d_NOTES.md` / `PHASE_9_NOTES.md` /
`PHASE_10_NOTES.md` / `PHASE_11a_NOTES.md` / `PHASE_11b_NOTES.md` /
`PHASE_11c_NOTES.md` / `PHASE_11d_NOTES.md` / `QA_HARDENING_NOTES.md` /
`PLATFORM_AUDIT.md` / `PHASE_12_NOTES.md` / `PHASE_13_NOTES.md` /
`PHASE_14_NOTES.md` / `PHASE_15_NOTES.md` / `PHASE_16_NOTES.md` /
`PHASE_16b_NOTES.md` for detailed status/handoff writeups. The
public marketing page
(`/`) also got a full redesign — an animated hero, a real feature grid, a comparison
section, an FAQ, and a further pass of hover/motion polish (animated nav underlines,
a gradient-ring reveal on feature cards, a pause-and-lift hover on the floating hero
mockups) — all CSS-only (no animation/icon library) so it stays fast on a mobile
connection; see `LANDING_PAGE_NOTES.md`.

**Tenant isolation is the single most load-bearing guarantee in this codebase.** Every
tenant-owned query is authorized through `src/lib/rbac/guard.ts`, which derives the
caller's identity from their server-side session — never from a client-supplied
`restaurant_id`. See `src/db/__tests__/tenant-isolation.test.ts` for the test proving
one restaurant cannot access another's data.

## Tech stack

- **Next.js 15** (App Router, TypeScript)
- **Drizzle ORM** + **postgres.js**, targeting **PostgreSQL** (developed against
  Supabase's hosted Postgres; also works against any Postgres instance)
- **Tailwind CSS v4**
- **Zod** for input validation
- **bcryptjs** for password hashing, custom server-side session cookies (not JWT —
  sessions are revocable instantly, which JWTs alone don't give you)
- **Vitest** for tests

Note: we deliberately did **not** use Prisma. Prisma's engine binaries are fetched
from `binaries.prisma.sh` at install/init time, which was blocked in the sandbox this
was originally built in. Drizzle is pure TypeScript/JS with no native binary
dependency, which also just makes it easier to deploy anywhere without worrying about
binary-target mismatches.

## Getting started

### 1. Install dependencies

```bash
npm install
```

### 2. Set up a Postgres database

**Recommended: Supabase (free tier).**

1. Create a project at [supabase.com](https://supabase.com).
2. Go to **Project Settings → Database → Connection string**.
3. Copy the **Transaction pooler** URI into `DATABASE_URL` and the **Session/Direct**
   URI into `DIRECT_URL` in your `.env.local` (copy `.env.example` to `.env.local`
   first). Fill in your actual database password in place of the placeholder.

**Alternative: any local/self-hosted Postgres.** Point `DATABASE_URL`/`DIRECT_URL` at
it. If it doesn't have SSL configured, add `?sslmode=disable` to the connection
string.

### 3. Run migrations and seed permissions

```bash
npm run db:generate   # regenerate migration SQL after schema changes (safe to skip on first run — already generated)
npm run db:migrate    # applies drizzle/*.sql to your database
npm run db:seed       # seeds the fixed permission catalog + default role→permission matrix
```

> We use a small custom script (`src/db/migrate.ts`) instead of the `drizzle-kit
> migrate` CLI to run migrations — the CLI hung indefinitely against a local Postgres
> in the original build sandbox even though the same connection worked fine through
> the app's own driver. The custom script uses the identical postgres.js driver the
> app uses at runtime and completes in under a second. If `drizzle-kit migrate` works
> fine in your environment, feel free to use it instead — `npm run db:generate` still
> uses the official CLI since that step never touches a live connection.

### 4. Run the app

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Register an account, walk through
the onboarding wizard to create your restaurant, and you'll land on the dashboard.

### 5. Run tests

```bash
npm test
```

Tests that need a live database (tenant isolation, RBAC) automatically skip themselves
if `DATABASE_URL` isn't set in your environment when running `vitest` directly — but
**they should be run at least once against a real database** before trusting this
codebase; `npm run db:migrate && npm run db:seed && npm test` (with `.env.local`
populated) runs everything including those.

## Project structure

```
src/
  app/
    (auth)/login, (auth)/register   — public auth pages
    onboarding/                     — restaurant creation wizard (protected)
    dashboard/                      — owner dashboard shell (protected — Phase 22:
                                       installable via public/manifest.json, and
                                       wraps a dashboard-wide service worker, see
                                       DashboardServiceWorker.tsx / public/
                                       dashboard-sw.js, for offline GET caching),
                                       incl. tables/, orders/ (the live order
                                       board — Phase 22: queues status changes
                                       locally via offline-status-queue.ts when
                                       offline, same pattern as POS below) +
                                       orders/[orderId] bill/payment view), pos/
                                       (staff order creation — Phase 11b: tracks
                                       connectivity, caches its menu, and queues
                                       orders locally via offline-queue.ts +
                                       IndexedDB when offline), kds/ (kitchen
                                       ticket board, grouped by station — Phase
                                       22: same offline status-queue as orders/),
                                       inventory/
                                       (suppliers, stock items, purchases, recipes),
                                       staff/ (roster + attendance), customers/
                                       (CRM list/detail, loyalty ledger + tier),
                                       expenses/ (filterable ledger + totals),
                                       reservations/ (day-scoped booking list), and
                                       reports/ (date-range KPI tiles, trend chart,
                                       top items, payment/expense breakdowns),
                                       branches/ (Phase 11a: branch list with add/
                                       rename/activate/deactivate), and assistant/
                                       (Phase 11d: owner/manager analytics Q&A chat,
                                       same VIEW_REPORTS gate as reports/); the layout
                                       itself redirects to /billing if the active
                                       restaurant's subscription is blocked
    billing/                        — TOP-LEVEL (deliberately not under dashboard/,
                                       so the blocked-subscription redirect above can
                                       never loop) — status, trial countdown, plan
                                       grid with a "request this plan" action, and a
                                       recent-activity timeline
    admin/                          — TOP-LEVEL, platform-admin-only console: an
                                       overview (stat tiles + searchable/filterable
                                       restaurant list) and a per-restaurant detail
                                       page with the full subscription action panel
                                       (extend trial, assign+activate plan, mark
                                       past due, cancel, reactivate) + event timeline
    order/[token]/                  — PUBLIC, unauthenticated QR ordering page
    api/auth/...                    — register / login / logout route handlers
    api/onboarding/...              — restaurant creation route handler
    api/order/[token]/              — PUBLIC order submission endpoint
    api/payments/gateway/[gateway]/callback/
                                     — Phase 11c: TOP-LEVEL, PUBLIC, unauthenticated —
                                       the browser lands here after eSewa/Khalti
                                       redirects back from their hosted payment page;
                                       identifies the transaction solely via our own
                                       gatewayReference, verifies it cryptographically
                                       (eSewa: local HMAC signature check; Khalti:
                                       server-to-server lookup by our stored pidx),
                                       then records an ordinary payments row and
                                       redirects to the order's dashboard page
    api/restaurants/[slug]/orders/  — order list, staff/POS order creation (Phase
                                       11b: an optional clientRequestId makes a
                                       retried submission idempotent — see
                                       lib/db-error.ts — instead of creating a
                                       duplicate order, the same request offline
                                       sync retries rely on), status
                                       transitions (incl. recipe-driven stock
                                       deduction on confirmed→preparing), order
                                       detail, and payments/refunds (split bills,
                                       refunds)
    api/restaurants/[slug]/orders/[orderId]/payments/gateway/[gateway]/initiate/
                                     — Phase 11c: starts a redirect-based eSewa/Khalti
                                       payment for the order's remaining due amount
                                       (gated behind EDIT_ORDER); generates our own
                                       gatewayReference, records a pending
                                       payment_gateway_transactions row, then either
                                       returns signed eSewa form fields or calls
                                       Khalti's initiate API
    api/restaurants/[slug]/suppliers/, inventory-items/, purchases/,
      menu-items/[itemId]/recipe/   — Phase 7 inventory subsystem, all gated
                                       behind MANAGE_INVENTORY
    api/restaurants/[slug]/staff/, attendance/
                                     — Phase 8 staff management (gated behind
                                       MANAGE_STAFF) and self-service attendance
                                       clock-in/clock-out
    api/restaurants/[slug]/customers/, customers/[customerId]/loyalty/adjust/
                                     — Phase 8b customer CRM + loyalty ledger, gated
                                       behind MANAGE_CUSTOMERS
    api/restaurants/[slug]/expenses/, expenses/[expenseId]/
                                     — Phase 8c expense ledger, gated behind the
                                       narrower MANAGE_EXPENSES (manager/owner only)
    api/restaurants/[slug]/reservations/, reservations/[reservationId]/,
      reservations/[reservationId]/status/
                                     — Phase 8d reservation booking + state machine,
                                       gated behind MANAGE_RESERVATIONS
    api/restaurants/[slug]/reports/summary/
                                     — Phase 9 bundled analytics endpoint (sales
                                       summary, daily revenue-vs-expenses series,
                                       top items, payment/expense breakdowns), gated
                                       behind VIEW_REPORTS
    api/restaurants/[slug]/billing/, billing/upgrade-request/
                                     — Phase 10: a restaurant's own subscription
                                       status/plan/history (open to any active staff
                                       member) and an owner-only "request this plan"
                                       action that logs an event for a platform admin
                                       to fulfill — both explicitly stay reachable
                                       even when the restaurant's own subscription is
                                       blocked
    api/admin/restaurants/, restaurants/[restaurantId]/,
      restaurants/[restaurantId]/subscription/
                                     — Phase 10 platform-admin console API,
                                       gated behind requirePlatformAdmin() rather
                                       than any restaurant-scoped permission: the
                                       cross-tenant restaurant list/detail, and the
                                       single PATCH choke point for every admin-driven
                                       subscription state change
    api/restaurants/[slug]/branches/, branches/[branchId]/
                                     — Phase 11a: branch list/create (gated behind
                                       MANAGE_BRANCHES, plan-tied branch-count cap)
                                       and per-branch rename/activate/deactivate
                                       (main-branch and last-active-branch guardrails
                                       enforced server-side)
    api/restaurants/[slug]/assistant/ask/
                                     — Phase 11d: the AI assistant's ask endpoint
                                       (gated behind VIEW_REPORTS, rate-limited per
                                       user); computes a trailing-30-day
                                       getReportSummary() snapshot and hands it to
                                       the model as its entire universe of facts —
                                       never gives the model direct database access
  db/
    schema.ts                       — Drizzle schema (source of truth for tables)
    index.ts                        — app's runtime DB client + the `Transaction`
                                       type for helpers called from inside
                                       db.transaction()
    migrate.ts                      — standalone migration runner (see above)
    seed.ts                         — seeds permissions + role_permissions
    __tests__/                      — DB-backed integration tests
  lib/
    auth/                           — password hashing, session management
    rbac/                           — permission catalog + the tenant-isolation guard
    validation/                     — Zod schemas for API input
    orders.ts                       — server-side order pricing (never trust the client)
    order-status.ts                 — the order lifecycle state machine (shared by the
                                       status API route and the dashboard board UI)
    payments.ts                     — billing math: net paid, remaining due, and the
                                       derived unpaid/partially_paid/paid status,
                                       shared by the payments/refunds routes and the
                                       dashboard bill view
    kds.ts                          — kitchen-driven status transitions + per-station
                                       ticket grouping, shared by the status API route
                                       and the KDS board
    inventory.ts                    — the stock-movement ledger choke point: atomic
                                       stock updates, weighted-average purchase
                                       costing, recipe-driven order deduction
    quantity.ts, inventory-units.ts — integer-milliunit quantity handling (the
                                       physical-quantity equivalent of money.ts),
                                       dependency-free
    attendance.ts, staff-roles.ts   — attendance duration math + the assignable-
                                       staff-role subset, both dependency-free,
                                       shared by the staff API routes and the
                                       dashboard staff board
    reports-helpers.ts, reports.ts  — Phase 9 analytics: pure date-range/series math
                                       (reports-helpers.ts) + the server-only
                                       aggregation queries (reports.ts) behind the
                                       bundled reports/summary endpoint
    plans.ts                        — Phase 10 plan catalog (Starter/Growth/Pro):
                                       placeholder pricing, per-plan staff-seat caps,
                                       and (Phase 11a) per-plan branch caps
                                       (maxBranchesForRestaurant), dependency-free
    subscription.ts                 — Phase 10 pure access logic:
                                       computeSubscriptionAccess derives allow/block
                                       purely from status + trialEndsAt vs. now, no
                                       DB read — usable from a server component
                                       (dashboard/layout.tsx) or an API route alike
    subscription-db.ts               — Phase 10 server-only: reconcileSubscriptionStatus,
                                       the lazy self-healing write that flips a
                                       lapsed trial to "expired" + logs an event
                                       exactly once on first discovery (no cron
                                       infra in this app), and recordSubscriptionEvent
    qr.ts                           — QR token generation + PNG rendering
    http-error.ts                   — shared base class for thrown-and-caught API errors
    db-error.ts                      — Phase 11b: isUniqueViolation(err) — recognizes a
                                       Postgres 23505 whether it's a raw postgres.js
                                       error or drizzle's DrizzleQueryError wrapping
                                       (err.cause.code) from inside db.transaction()
    offline-queue.ts                 — Phase 11b, browser-only: the IndexedDB-backed
                                       queue of orders taken while offline (POS UI
                                       only — never imported server-side)
    payment-gateways/config.ts       — Phase 11c: getEsewaConfig()/getKhaltiConfig() —
                                       eSewa defaults to its public UAT test key
                                       (safe, sandbox-only); Khalti has no shared
                                       sandbox key, so KHALTI_SECRET_KEY is required
                                       with no fallback
    payment-gateways/esewa.ts        — Phase 11c: builds signed eSewa form-POST
                                       fields, verifies a callback's HMAC-SHA256
                                       signature (pure local computation, no
                                       network), and an optional server-to-server
                                       status check (injectable fetchImpl)
    payment-gateways/khalti.ts       — Phase 11c: Khalti KPG v2 REST initiate +
                                       lookup calls, both with an injectable
                                       fetchImpl so they're unit-testable without
                                       live network (blocked from this build sandbox)
    ai/config.ts                     — Phase 11d: getAnthropicConfig() — no shared
                                       sandbox key exists for an LLM API (unlike
                                       eSewa), so ANTHROPIC_API_KEY is required with
                                       no fallback; ANTHROPIC_MODEL is a separate env
                                       var so a retired model alias is a one-line fix
    ai/assistant.ts                  — Phase 11d: buildSystemPrompt() (pure —
                                       serializes a getReportSummary() snapshot into
                                       the model's entire universe of facts, so it
                                       structurally cannot leak data it was never
                                       given) and askAssistant() (Anthropic Messages
                                       API call with an injectable fetchImpl)
    restaurant.ts, slug.ts, audit.ts, rate-limit.ts, api-client.ts, request.ts
  middleware.ts                     — optimistic auth redirect; NOT the source of
                                       truth for authorization — that's guard.ts
```

## Security notes (read before adding features)

- **Never trust a `restaurant_id`/`branch_id` from the client for authorization.**
  Always resolve it through `requireAuth()` → `requireRestaurantAccess()` /
  `requirePermission()` / `requireBranchAccess()` in `src/lib/rbac/guard.ts`.
- Passwords are hashed with bcrypt (cost 12); session tokens are high-entropy random
  values, SHA-256 hashed before being stored server-side (sessions are revocable —
  logout actually deletes the row, not just the cookie).
- Auth endpoints are rate-limited (see `src/lib/rate-limit.ts` for an important caveat:
  it's in-memory and single-instance only — swap for Redis/Upstash before running more
  than one app instance). **This is a hard requirement, not a nice-to-have**: every
  IP/user-keyed limit in this app (login attempts, gateway-callback abuse, public
  order-page throttling) lives in one process's memory, with zero code-level guard
  against a second instance. Deploying to a horizontally-scaled serverless platform
  (Vercel's own model — a request can land on any of several concurrent function
  instances) or running `pm2` in cluster mode silently multiplies every limit by the
  instance/worker count instead of erroring — see the "Deploying" section below for
  which of the documented platforms this actually holds for.
- The public QR ordering endpoint (`POST /api/order/[token]`) is unauthenticated by
  design — the qrToken itself is the access control — so it's rate-limited by both IP
  and table, and **never** trusts a price from the client: `computeOrderPricing()` in
  `src/lib/orders.ts` recomputes every unit price, addon price, and tax rate from the
  current menu rows in the database. The request schema doesn't even have a price
  field to send.
- JSON API routes require a custom `x-restromitra-client` header as CSRF defense-in-depth
  alongside `SameSite=Lax` session cookies (see `src/lib/request.ts`).
- Sensitive actions are written to `audit_logs` (`src/lib/audit.ts`) — auth events,
  restaurant creation, order status changes, and (as of Phase 5) every payment and
  refund recorded; extend this as new sensitive actions ship (price changes, discounts,
  staff permission changes, etc., per the product spec).
- Refunds require `REFUND_ORDER` (owner + manager by default — see
  `DEFAULT_ROLE_PERMISSIONS` in `src/lib/rbac/permissions.ts`), one tier above the
  `EDIT_ORDER` permission that gates recording an ordinary payment. Every payment/refund
  route re-validates the amount server-side against the live ledger (an overpayment or
  an over-large refund is rejected with a 400) — never trusted from the client beyond
  the number itself.
- The order status route accepts EITHER of two permissions for the two kitchen-driven
  transitions (`confirmed→preparing`, `preparing→ready`) via `requireAnyPermission()` in
  `src/lib/rbac/guard.ts` — `EDIT_ORDER` or the narrower `UPDATE_KDS_STATUS` — but every
  other transition (accepting, serving, cancelling) still requires `EDIT_ORDER`/
  `CANCEL_ORDER` specifically, so `kitchen_staff` can't take actions outside the kitchen.
- The entire inventory subsystem (suppliers, stock items, purchases, recipes) — reads
  included, not just writes — requires `MANAGE_INVENTORY`; ingredient/cost data is
  treated as more sensitive than menu availability and isn't visible to waiters/
  cashiers/kitchen staff by default. Recipe cost fields are additionally gated behind
  `VIEW_PROFIT` via the non-throwing `hasPermission()` helper in `guard.ts`.
- Inventory quantities are stored as integer milliunits (never floats), the same
  "integers only" reasoning `money.ts` uses for paisa — see `src/lib/quantity.ts`.
  `inventory_items.currentStockMilliunits`/`costPerUnitInPaisa` are cached/derived from
  the `stock_movements` ledger, never hand-edited; always go through
  `src/lib/inventory.ts`'s helpers to change them.
- Staff management (`.../staff/`) is gated behind `MANAGE_STAFF` and refuses to touch
  an `owner`/`platform_admin` grant or let a caller deactivate their own access —
  see `src/app/api/restaurants/[slug]/staff/[userRoleId]/route.ts`. `users.phone` is
  globally unique, so adding staff is a find-or-create: an existing account is just
  granted a new role at the restaurant in question, never duplicated.
- Before commercial launch: get current Nepal IRD / billing-software / PAN-VAT
  requirements confirmed by a qualified professional. Tax configuration is kept
  separate from UI logic specifically so it can be adjusted without a rearchitecture.

## Deploying

Any Next.js-compatible host works technically — there's no Prisma-style native binary
tying it to a specific platform — but **only a genuinely single-process deployment is
actually correct for this app today**, because of the in-memory rate limiter above. The
verified, currently-live target is a single-instance Hostinger Node.js app (hPanel →
Node.js — see `DEPLOY_PHASE25.md` for the concrete steps); a single VPS process (with or
without `pm2` in **fork** mode, which is still one process) is equally fine.

**Vercel and `pm2` cluster mode are NOT drop-in equivalents** — RC audit correction: an
earlier version of this section presented them as interchangeable "any host works"
alternates, which was wrong. Vercel's serverless model can and does run a given route's
handler on more than one concurrent function instance, and `pm2 -i <n>` cluster mode
runs `<n>` separate Node processes — either one silently multiplies every rate limit by
however many instances/workers happen to be live, with no error or warning anywhere.
Vercel steps are kept below for reference (the app itself runs fine there), but treat
its rate-limiting as effectively disabled unless `src/lib/rate-limit.ts` is first
swapped for a shared store (Redis/Upstash) — do not launch commercially on it as-is.

### Deploying to Vercel

1. **Push this repo to GitHub** (already done if you're reading this from the repo),
   then go to [vercel.com/new](https://vercel.com/new) and import it. Vercel
   auto-detects the Next.js framework, build command (`next build`), and output — no
   `vercel.json` needed.

2. **Provision a production Postgres database** — Supabase's free tier is the easiest
   (see "Getting started" above for the exact steps). Any Postgres works; Supabase is
   just pre-wired into these docs' pooled/direct URL split, which matters for a
   serverless host like Vercel (see next point).

3. **Set environment variables** in the Vercel project's **Settings → Environment
   Variables**, for all three environments (Production/Preview/Development), before
   the first deploy — several routes read `DATABASE_URL` at module load time, so a
   build without it configured will fail outright, not just misbehave at runtime.
   Copy every key from `.env.example`; the ones that matter most:

   | Variable | Required | Notes |
   |---|---|---|
   | `DATABASE_URL` | Yes | The **pooled** (transaction-mode, port 6543 on Supabase) connection string — Vercel's serverless functions open a fresh connection per invocation, so an unpooled URL here will exhaust Postgres' connection limit under real traffic. |
   | `DIRECT_URL` | Yes, for migrations | The **direct/session** (port 5432) connection string. Not read by the running app, only by `npm run db:migrate` / `drizzle-kit generate` — see step 5. |
   | `AUTH_SECRET` | No | Kept for compatibility with hosts/checklists that expect it, but **not actually read anywhere in application code** — sessions use a random opaque DB-backed token (`src/lib/auth/session.ts`), not a JWT. Safe to leave unset; if set, `openssl rand -base64 48` and don't reuse a dev value. |
   | `APP_URL` | Yes | Your production URL, e.g. `https://restromitra.vercel.app` or a custom domain — used to build absolute links (QR codes, the public website builder's `/site/[slug]` links). |
   | `NODE_ENV` | No | Vercel sets this itself; no need to set it manually. |
   | `KHALTI_SECRET_KEY`, `ESEWA_*` | Only if using payment gateways | Leave unset to disable that gateway rather than deploying with a placeholder — see `.env.example`'s comments. |
   | `GROQ_API_KEY` or `ANTHROPIC_API_KEY` (+ `AI_PROVIDER`) | Only if using the AI assistant | The `/dashboard/assistant` page degrades gracefully without one; it doesn't break the rest of the app. |

4. **Deploy.** Vercel builds and deploys on push automatically once connected. The
   first deploy will fail if step 3 was skipped — check the build logs for a
   `DATABASE_URL is not set` error, which means an env var is missing on that specific
   environment (Production vs Preview are configured separately).

5. **Run migrations against production** — Vercel does not run `npm run db:migrate`
   for you as part of a deploy (there's no post-build hook wired up for it). Run it
   from your own machine, pointed at the production database, once per schema change:

   ```bash
   DATABASE_URL="<production pooled URL>" DIRECT_URL="<production direct URL>" \
     npm run db:migrate
   ```

   Then seed the permission catalog once, the first time only (idempotent — safe to
   re-run, but unnecessary after the first time):

   ```bash
   DATABASE_URL="<production pooled URL>" npm run db:seed
   ```

6. **Verify.** Visit the deployed URL, register an account, and walk through
   onboarding — this exercises the DB connection, session cookies, and RBAC seed data
   end to end. If registration works, the deploy is healthy.

### Deploying to Netlify

Netlify works too, via the official `@netlify/plugin-nextjs` runtime (auto-installed —
no manual plugin setup needed). `netlify.toml` at the repo root already pins the build
command and publish directory, so importing the repo needs no manual configuration
beyond env vars.

1. **Push this repo to GitHub**, then go to
   [app.netlify.com](https://app.netlify.com) → **Add new site → Import an existing
   project**, and pick the repo. Netlify reads `netlify.toml` and detects Next.js
   automatically.

2. **Provision Postgres and set environment variables** — identical to the Vercel
   steps above (same env var table, same pooled-vs-direct URL split). Set them under
   **Site configuration → Environment variables**.

3. **Deploy, then run migrations and verify** — same as Vercel steps 4–6 above.
   Netlify doesn't run `db:migrate` for you either.

**Why this app is pinned to Next.js 15, not 16:** it was originally built against
Next 16, but Next 16.3.1's production build has an open upstream bug where static-page
generation can crash while prerendering with `Cannot read properties of null (reading
'useContext')` — confirmed to fail consistently on Netlify's build machines across
several independent build configurations (Turbopack and webpack, 1 worker and default
concurrency, Node 22.22 and 22.23), none of which fixed it, and never reproducible in
local testing. See [vercel/next.js#95741](https://github.com/vercel/next.js/issues/95741),
[vercel/next.js#86178](https://github.com/vercel/next.js/issues/86178), and
[vercel/next.js#84994](https://github.com/vercel/next.js/issues/84994) for the upstream
reports. Next 15.5.x doesn't have this bug. Worth revisiting the Next 16 upgrade once
that's resolved upstream — the app itself has no Next-16-only code left (route handlers
use inline `Promise<{...}>` param types rather than Next 16's generated `RouteContext`
helper, and `middleware.ts` uses its Next-15-era name and export).

### Notes specific to a serverless host

- `src/middleware.ts` only checks for a session cookie's presence for redirect
  purposes; it does no DB work, so it's cheap to run on every request at the edge.
- The `postgres` driver is configured with `prepare: false` (see `src/db/index.ts`)
  specifically so it works against Supabase's transaction-mode pooler — don't remove
  that if you swap the connection string for an unpooled one, or re-add it if you
  swap to a pooler that needs it.
- Image uploads (menu item photos, restaurant logo, website builder hero/gallery
  images) are client-compressed into `data:` URLs and stored directly in Postgres
  columns — there's no object-storage/CDN dependency to configure for a first deploy.
