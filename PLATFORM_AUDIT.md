# DhankiPOS — Platform Audit & Roadmap (Phase 0)

Produced in response to a full-scope product spec for turning DhankiPOS into a
comprehensive restaurant-OS + customer-platform + AI-manager SaaS for Nepal.
This document is the required first step: an audit of what already exists,
before any of that spec gets built. It was produced by reading actual source
code (schema, routes, lib functions, UI components) across the whole
codebase at `/home/claude/dhankipos` — not by assumption. Every row below is
backed by a real file path; where a calculation or formula matters, the
actual code is quoted.

**How to read this document.** The spec's 80 sections describe a large,
multi-year platform. DhankiPOS today (Phases 1–11d + a QA hardening pass) is
a real, working, tested, tenant-isolated restaurant back-office system — not
a demo. It is genuinely strong in the areas it covers: financial
correctness, tenant isolation, RBAC, offline order capture, inventory/recipe
costing, and an AI Q&A assistant. It has real, specific gaps against the
full spec, mostly in areas that were never attempted yet (coupons, floor
plans, table status, customer self-service accounts, a restaurant website
builder, discovery/marketplace, notifications, printing) rather than areas
that are "half-broken." Nothing found here suggests the existing system
needs to be rewritten — the roadmap at the end proposes building the gaps
on top of what's there.

---

## 1. Architecture summary

**Stack**: Next.js 16.3.1 (App Router, typed `RouteContext` route params),
React 19.2.8, TypeScript 5 strict, Tailwind CSS v4, Drizzle ORM 0.45 +
postgres.js driver, PostgreSQL, Vitest 4 (351 tests / 46 files, all
passing), Playwright (used for manual screenshot scripts, not an automated
E2E suite — see §7).

**Multi-tenancy model — important divergence from the spec's hierarchy.**
The spec describes `PLATFORM → ORGANIZATION → BRANCH`. The actual system is
`PLATFORM → RESTAURANT → BRANCH` — there is no `organizations` table or
concept. `restaurants` is the tenant root directly. A `users` row is a
platform-wide identity; `user_roles` grants a role to a user at a specific
`restaurantId` (+ optional `branchId` for branch-scoped staff). One person
*can* own multiple restaurants (multiple `user_roles` rows), but there is no
UI to switch between them after onboarding — a session tracks exactly one
`active_restaurant_id`, set once and never changed. See §3 for what this
means in practice and what to do about it.

**Money & quantity discipline**: everything financial is integer paisa
(`src/lib/money.ts`), everything inventory-quantity is integer milliunits
(`src/lib/quantity.ts`) — no floats anywhere in the money/stock path. Every
mutating table has an append-only ledger backing a cached/derived field
(`payments` ledger → `orders.paymentStatus`; `stock_movements` ledger →
`inventory_items.currentStockMilliunits`) — this pattern is applied
consistently and is one of the codebase's real strengths.

**RBAC**: 19 permission keys, 7 system roles (`platform_admin, owner,
manager, cashier, waiter, kitchen_staff, inventory_manager`), enforced
server-side via `src/lib/rbac/guard.ts` in every one of the 46 tenant API
routes — confirmed by direct grep, not sampling. Tenant identity is always
re-derived from a session + slug lookup, never trusted from client input.

**Testing**: 351 Vitest tests (including a real Postgres-backed
`tenant-isolation.test.ts`), 15 live smoke-test shell scripts, and a
concurrency-race verification script (`qa-hardening-verify.mjs`) that
proves 5 real-money race conditions are closed. None of this runs in CI
today — see §7.

---

## 2. Master feature audit table

Status legend: **COMPLETE** = built, tested, working. **PARTIAL** = a real
implementation exists but is missing pieces the spec asks for. **MISSING** =
confirmed absent by direct code search, not assumed.

### 2.1 Core architecture, security, multi-tenancy, SaaS

| Feature | Status | Files | DB tables | Priority |
|---|---|---|---|---|
| Multi-tenancy (restaurant-as-tenant) | COMPLETE | `src/lib/rbac/guard.ts`, `src/lib/api-route-helpers.ts` | `restaurants`, `branches`, `user_roles` | P0 (keep) |
| Organization layer (group multiple restaurants under one company) | MISSING | — | — | P3 |
| Org/branch switcher UI | MISSING | — | `sessions.active_restaurant_id` (single value) | P1 |
| RBAC / permissions | COMPLETE | `src/lib/rbac/{guard,permissions}.ts` | `permissions`, `role_permissions`, `user_roles` | P0 (keep) |
| Authentication | COMPLETE | `src/lib/auth/session.ts` | `users`, `sessions` | P0 (keep) |
| Audit logging (write path) | COMPLETE | `src/lib/audit.ts`, ~48 call sites | `audit_logs` | P0 (keep) |
| Audit log viewer (read/admin UI) | MISSING | — | `audit_logs` (unread) | P1 |
| Security hardening (CSRF, rate-limit, validation, SQLi) | COMPLETE | `src/lib/request.ts`, `rate-limit.ts`, 20 zod schemas | — | P0 (keep) |
| Rate limiter production-readiness | PARTIAL | `src/lib/rate-limit.ts` | — | P0 — in-memory only, won't survive multi-instance deploy, already flagged in code |
| SaaS subscriptions | PARTIAL | `src/lib/plans.ts`, `subscription*.ts` | `restaurants` (status/trial/plan), `subscription_events` | P1 — plans hardcoded in code, not DB-configurable; no automated payment→subscription linkage |
| Platform super admin | PARTIAL | `src/app/admin/*` | reads `restaurants`, `user_roles`, `subscription_events` | P1 — no audit-log view, no restaurant create/deactivate, no platform_admin management UI |

### 2.2 POS, order engine, KOT/KDS/BDS, offline, tables, QR

| Feature | Status | Files | DB tables | Priority |
|---|---|---|---|---|
| POS core (dine-in/takeaway, variants, addons, notes) | COMPLETE | `POSOrderBuilder.tsx`, `src/lib/orders.ts` | `orders`, `order_items`, `order_item_addons` | P0 (keep) |
| Discounts (order/line-level) | MISSING | — | — | **P0** |
| Coupons/promo codes | MISSING | — | — | P1 |
| Tax | COMPLETE | `menu_items.taxRateBasisPoints` | `menu_items`, `orders.taxInPaisa` | P0 (keep) |
| Service charge | MISSING | — | — | **P0** |
| Tips/gratuity | MISSING | — | — | P1 |
| Split bill (amount-based) | PARTIAL | `payments` route | `payments` | P1 — no item-level split, no "split evenly N ways" helper |
| Multiple payment methods per order | COMPLETE | same | `payments.method` enum | P0 (keep) |
| Partial payment | COMPLETE | `src/lib/payments.ts` | `orders.payment_status` (derived) | P0 (keep) |
| Refund | COMPLETE | `refunds` route | `payments` (signed) | P0 (keep) |
| Void (distinct from cancel) | MISSING | — | — | P1 |
| Hold / resume order (park cart) | MISSING | — | — | **P0** |
| Table transfer / merge / split | MISSING | — | — | **P0** |
| Assign waiter to order/table | MISSING | — | — | P1 |
| Order engine / lifecycle | COMPLETE (simpler than spec) | `src/lib/order-status.ts` | `orders.status` | P0 (keep) — `pending→confirmed→preparing→ready→served→completed`/`cancelled`; no DRAFT/SENT_TO_KITCHEN/VOIDED/REFUNDED as distinct statuses |
| Per-transition timestamps | PARTIAL | `orders.updatedAt` only | `orders` | P2 — full history only via audit_logs, not queryable off the order row |
| KOT (distinct kitchen ticket) | MISSING | — | — | **P0** |
| KDS | PARTIAL | `src/lib/kds.ts`, `KDSBoard.tsx` | reads `orders`, `order_items` | P0 — real multi-station routing; **no urgency/color thresholds** |
| BDS (separate bar display) | MISSING | — | `kitchen_stations` (no type field) | P1 — bar is just another KDS station tab today |
| Offline POS + sync (order creation) | COMPLETE | `src/lib/offline-queue.ts`, `pos-sw.js` | `orders.client_request_id` (idempotent unique) | P0 (keep) — no bulk 50-order test done yet, no background retry timer |
| Floor plan (visual drag-and-drop) | MISSING | — | `restaurant_tables` has no position/shape fields | **P0** |
| Table status (available/occupied/reserved/cleaning) | MISSING | — | `restaurant_tables` has only `isActive` | **P0** |
| QR ordering (customer-facing) | PARTIAL | `order/[token]/*` | `restaurant_tables.qrToken` | P0 — secure token, real pricing; no order tracking after submit, no "request bill", no pay-from-phone |

### 2.3 Menu, combos, inventory, recipes, purchasing

| Feature | Status | Files | DB tables | Priority |
|---|---|---|---|---|
| Menu (categories/items/variants/addons/tax/images/prep-time/station) | COMPLETE | `menu-items/*` routes | `categories`, `menu_items`, `menu_variants`, `menu_addons` | P0 (keep) |
| Scheduled availability windows | MISSING | — | — | P2 |
| Featured/popular flags | MISSING | — | — | P2 |
| Combos / meal deals | MISSING | — | — | P1 |
| Inventory core (items, units, suppliers, stock ledger) | COMPLETE | `src/lib/inventory.ts` | `inventory_items`, `stock_movements`, `suppliers` | P0 (keep) |
| Unit conversion (g↔kg) | MISSING | — | `inventory_items.unit` (single unit only) | P2 |
| Low-stock detection | COMPLETE (threshold only) | `isLowStock()` | `inventory_items.reorderLevelMilliunits` | P0 (keep) |
| Inventory intelligence / forecasting (stockout ETA) | MISSING | — | — | P1 |
| Waste tracking (dedicated) | PARTIAL | generic adjustment + free-text reason | `stock_movements.type` (no `waste` type) | P2 |
| Expiry/lot tracking | MISSING | — | — | P2 |
| Stock transfers between branches | MISSING | — | inventory not branch-scoped at all today | P1 |
| Branch-level inventory scoping | MISSING | — | `inventory_items` has no `branchId` | P1 |
| Recipe management (BOM) | COMPLETE | `recipe` route | `recipe_items` | P0 (keep) |
| Automatic recipe stock deduction | COMPLETE | `deductRecipeStockForOrder()` | `stock_movements` | P0 (keep) |
| Recipe cost-per-serving | COMPLETE | recipe route | — | P0 (keep) |
| Per-item margin/profit (cost vs. selling price) | MISSING | cost exists, never joined to price | — | **P0** |
| Suppliers / purchasing | COMPLETE (no PO approval stage) | `purchases` route | `purchases`, `purchase_items` | P1 — purchase = instant receiving, no draft/approve workflow |

### 2.4 Staff, attendance, expenses, finance, payments

| Feature | Status | Files | DB tables | Priority |
|---|---|---|---|---|
| Staff management (CRUD, roles, branch assignment) | COMPLETE | `staff/*` routes | `users`, `user_roles` | P0 (keep) |
| Shifts / schedules | MISSING | — | — | P2 |
| Leave management | MISSING | — | — | P2 |
| Overtime detection | MISSING | — | — | P2 |
| Staff performance tracking | MISSING | — | — | P3 |
| Cashier till reconciliation | MISSING | — | — | P1 |
| Attendance clock-in/out | COMPLETE (basic) | `attendance/*` routes | `attendance_records` | P0 (keep) |
| Selfie/photo verification | MISSING | — | — | P2 |
| Break tracking, late/overtime detection | MISSING | — | — | P2 |
| Expenses (categories, date, void) | PARTIAL | `expenses` route | `expenses` | P1 — no branch scoping, no recurring, no receipts/attachments |
| Financial reporting (revenue/expenses/net profit) | PARTIAL | `src/lib/reports.ts` | reads `orders`,`payments`,`expenses` | P0 — net profit = revenue − expenses only, not COGS-based |
| Discounts/tips/service-charge in financials | MISSING | — | — | **P0** (same gap as §2.2) |
| Payment methods | PARTIAL | `payments` table | fixed enum: cash/card/mobile_wallet/other | P1 — hardcoded enum, not admin-configurable, no distinct bank_transfer value |
| Payment gateways (eSewa/Khalti) | COMPLETE | `payment-gateways/*` | `payment_gateway_transactions` | P0 (keep) |
| Customer credit/due (running balance across orders) | MISSING | — | `customers` has no balance/credit columns | P1 |

### 2.5 Customer CRM, loyalty, coupons, reviews, reservations

| Feature | Status | Files | DB tables | Priority |
|---|---|---|---|---|
| Customer CRM (staff-side lookup/history) | COMPLETE | `customers/*` routes | `customers`, `loyalty_transactions` | P0 (keep) |
| Customer self-service accounts (signup/login/history) | MISSING | — | — | **P0** — required for any customer-platform work (§2.6) |
| Loyalty (single restaurant) | PARTIAL | `src/lib/loyalty.ts`, `loyalty-tiers.ts` | `loyalty_transactions` | P0 (keep) — real earn/tier system; no streaks, birthday, referral, or point expiry |
| Cross-restaurant loyalty | MISSING | — | — | P2 |
| Coupons/promotions | MISSING | — | — | P1 |
| Customer reviews/ratings | MISSING | — | — | P2 |
| Reservations (CRUD, status, table link) | COMPLETE | `reservations/*` routes | `reservations` | P0 (keep) |
| **Reservation double-booking prevention** | MISSING | — | `reservations.durationMinutes` (unused for this) | **P0 — code comment claims a "soft UI warning" that does not actually exist; two reservations can double-book the same table right now** |
| Reservation deposits | MISSING | — | — | P2 |
| Reservation reminders (SMS/email) | MISSING | — | — | P1 |
| Reservation calendar (week/month grid) | MISSING (day-list only) | `ReservationsBoard.tsx` | — | P2 |
| Waitlist | MISSING | — | — | P2 |
| Customer self-booking (no staff involvement) | MISSING | — | — | P1 |

### 2.6 Dashboard, analytics, AI

| Feature | Status | Files | Priority |
|---|---|---|---|
| Dashboard (today/live KPIs) | PARTIAL | `src/app/dashboard/page.tsx` | **P0** — only today's sales + order count are real; 1 tile is a hardcoded "0" leftover placeholder; no profit/expenses/AOV/reservations/table-occupancy/order-status funnel |
| Advanced analytics — sales/products/financial | PARTIAL | `src/lib/reports.ts` | P0 (keep, extend) — real revenue/AOV/top-items/payment-breakdown; only daily granularity, no hourly/weekly/monthly/yearly, no previous-period comparison |
| Advanced analytics — operations (peak hours, prep time, table utilization) | MISSING | — | P1 |
| Advanced analytics — customers (returning, CLV) | MISSING | — | P1 |
| Advanced analytics — reservations (no-show rate) | MISSING | — | P2 |
| Per-item margin integrated into reports | MISSING | cost data exists in Phase 7, not joined | **P0** (same as §2.3) |
| AI Restaurant Manager (Q&A) | COMPLETE (scoped) | `src/lib/ai/*` | P0 (keep) — real Anthropic integration, strictly read-only, structurally can't invent data |
| AI data access scope | PARTIAL by design | — | P1 — only sees 30-day sales/expense snapshot; no inventory/customer/reservation data reaches the model yet |
| AI actions (write capability) | MISSING (deliberate) | — | P2 |
| AI forecasting | MISSING | — | P2 |

### 2.7 Website, discovery, notifications, localization, ops

| Feature | Status | Files | Priority |
|---|---|---|---|
| DhankiPOS marketing site | COMPLETE | `src/app/page.tsx` | P0 (keep) |
| Restaurant website builder (per-tenant public site) | MISSING | — | P1 |
| Restaurant discovery/marketplace | MISSING | — | P2 |
| Email notifications | MISSING | — | **P0** — no provider wired at all (order confirmations, reservation confirmations, receipts all currently silent) |
| SMS notifications | MISSING | — | P1 |
| Push/in-app notification center | MISSING | — | P1 |
| SEO (marketing site) | PARTIAL | `layout.tsx` | P2 — title/description only, no OG/JSON-LD/sitemap |
| NPR/paisa handling | COMPLETE | `src/lib/money.ts` | P0 (keep) |
| Timezone (Asia/Kathmandu) | PARTIAL | `restaurants.timezone` column exists, unused | P1 — dashboard/reports currently compute "today" in UTC, not restaurant-local time |
| BS calendar | MISSING | — | P3 |
| i18n (English/Nepali) | MISSING | `restaurants.defaultLocale` column exists, unused | P2 |
| Nepal phone/address validation | COMPLETE | `src/lib/validation/*` | P0 (keep) |
| Configurable tax/VAT | COMPLETE (per menu item) | `menu_items.taxRateBasisPoints` | P0 (keep) |
| Global cross-entity search | MISSING | — | P2 |
| CSV import (menu/customers/inventory/staff) | MISSING | — | P1 |
| CSV/PDF export (reports) | MISSING | — | P1 |
| Printer management (KOT/receipt/bar printers) | MISSING | — | **P0** |

### 2.8 Testing, deployment, design system

| Feature | Status | Notes | Priority |
|---|---|---|---|
| Unit/integration tests | COMPLETE | 351 tests / 46 files, all passing, includes a real-Postgres tenant-isolation test | P0 (keep) |
| Live smoke tests | COMPLETE (manual) | 15 shell scripts against a live server | P0 (keep) |
| Concurrency/race tests | COMPLETE (manual) | `qa-hardening-verify.mjs`, 5 scenarios, 13 assertions | P0 (keep) |
| Automated E2E test suite (Playwright test runner) | MISSING | Only ad-hoc screenshot scripts exist, no `*.spec.ts`/assertions | P1 |
| CI/CD | MISSING | No `.github/workflows`, nothing runs automatically on push | **P0** |
| Deployment config as code | MISSING | Prose-only README guidance, no Dockerfile/IaC | P1 |
| Env/secrets management | COMPLETE | `.env.example` fully documented, nothing committed | P0 (keep) |
| Design system | PARTIAL | 3 shared CSS utility classes (`.btn-primary` etc.), not a React component library | P2 — valid lightweight pattern, but will get harder to keep consistent as surface area grows |
| Performance — pagination | PARTIAL | Fixed `.limit(N)` caps everywhere, no real offset/cursor pagination | P1 |
| Performance — caching | MISSING | No Next cache directives, no Redis | P2 |
| Performance — DB indexes | COMPLETE | 60+ explicit indexes/unique constraints | P0 (keep) |

---

## 3. Architectural conflicts & considerations

1. **Organization layer.** The spec assumes `PLATFORM → ORGANIZATION →
   BRANCH`; the real system is `PLATFORM → RESTAURANT → BRANCH` with no
   grouping entity above `restaurants`. This is fine for the Itahari-first,
   single-restaurant-per-owner target market and doesn't need to change
   now. It becomes relevant only if/when a chain (one company, several
   distinct restaurant brands) becomes a real customer — at that point an
   `organizations` table wrapping multiple `restaurants` rows is a clean
   additive migration, not a rewrite. Flagging as P3, not blocking anything
   today.
2. **No restaurant/branch switcher.** The data model already supports one
   user holding roles at multiple restaurants, but there's genuinely no way
   to use that today post-onboarding — `active_restaurant_id` is set once.
   Worth fixing (P1) before any multi-branch or multi-restaurant owner
   relies on it in practice.
3. **Table status doesn't exist.** `restaurant_tables` has only a boolean
   `isActive` (soft-delete), no AVAILABLE/OCCUPIED/RESERVED/CLEANING state.
   This blocks several spec asks directly: dashboard "occupied vs available
   tables," a floor plan with color-coded tables, and reservation-to-table
   assignment feedback. This is a foundational P0 gap other features sit on
   top of.
4. **Zero discount/tip/service-charge concept anywhere in the money
   model.** Not partially built — entirely absent from the schema. Every
   order today is full menu price, no exceptions. This is probably the
   single highest-impact gap for a real restaurant's day-to-day operation
   (a manager not being able to comp a dish or apply a 10% off is a
   business blocker, not a nice-to-have) and touches `orders`,
   `order_items`, pricing logic, reports, and receipts — worth treating as
   its own focused phase rather than bolting on piecemeal.
5. **Recipe costing and reporting live in two separate, unconnected
   places.** Phase 7 computes accurate per-serving ingredient cost; Phase 9
   reports compute restaurant-wide revenue − expenses. Nothing joins them
   into a per-item margin or a COGS-based gross profit figure, despite
   both pieces already existing. This is a genuinely cheap, high-value fix
   (join existing data, no new subsystem) — good first target.
6. **Reservation "double-booking prevention" is documented as existing but
   isn't.** A schema comment explicitly claims a "soft UI warning" for
   overlapping bookings; the actual `ReservationsBoard.tsx` and the
   create/update routes have no such check. This is a real, live bug
   (not just a missing feature) worth fixing before reservations are
   trusted for a real Saturday-night service.
7. **In-memory rate limiting and hardcoded SaaS plans** both work correctly
   today but are explicitly single-instance/manual-only by design — neither
   blocks anything now, but both need to change before a second app
   instance or self-serve billing goes live.
8. **No CI.** Every one of the strong testing assets described in §2.8
   (351 tests, 15 smoke scripts, the concurrency verifier) runs only when a
   human remembers to run it. Wiring even the Vitest suite into GitHub
   Actions on every push is cheap and meaningfully de-risks everything
   else on this roadmap.

---

## 4. P0 priority list (cross-referenced against the audit, not assumed from the spec)

Genuinely blocking, in rough dependency order:

1. **Table status** (AVAILABLE/OCCUPIED/RESERVED/CLEANING) — foundational; floor plan, dashboard live-ops, and reservation UX all sit on top of this.
2. **Discounts, service charge, tips** as first-class order/payment concepts — the single biggest POS gap for real-world use.
3. **Reservation double-booking prevention** — a live correctness bug, not just a missing feature.
4. **Per-item margin/profit in reports** — cheap (join existing data), high business value.
5. **Dashboard real KPIs** — replace the hardcoded placeholder tile, add the live order-status funnel and table occupancy the spec (and any real manager) expects at a glance.
6. **Hold/resume order + table transfer** — real counter-service workflows the current POS can't do at all.
7. **KOT as a distinct printable ticket + printer management** — currently folded entirely into the KDS screen; no printing story exists at all.
8. **KDS urgency thresholds** — cheap addition (elapsed-time coloring) with real kitchen-floor impact.
9. **Customer self-service accounts** — prerequisite for essentially all of §2.6/§78's customer-platform vision (reservations, ordering, loyalty, reviews from the customer's own device/account).
10. **Email notifications (order/reservation confirmations)** — currently silent; cheapest communication channel to wire up first.
11. **CI on the existing test suite** — de-risks every subsequent phase above.

---

## 5. Roadmap — reconciled against existing Phase 1–11d work

The spec's Phase 0–19 structure is sound as a shape, but phases 2–7 assume
starting from nothing; DhankiPOS already has strong partial coverage of
most of them. Rather than re-running phases that are substantially done,
this roadmap marks each of the spec's phases against what's actually true
today and sequences the real remaining work by the P0 list above.

| Spec phase | Real status today | What's actually left |
|---|---|---|
| Phase 0 — Existing project audit | **DONE** (this document) | — |
| Phase 1 — Architecture/security/multi-tenancy audit | **DONE** (folded into this document, §1–§3) | Org-layer/branch-switcher decision (P3/P1, not blocking) |
| Phase 2 — Production POS hardening | **MOSTLY DONE** (QA hardening pass already closed 5 real race conditions) | Add discounts/service-charge/tips, hold/resume, table transfer (P0 items #2, #6) |
| Phase 3 — Offline POS and sync | **MOSTLY DONE** | Bulk 50-order/reconnect test, periodic background retry (P1) |
| Phase 4 — KOT/KDS/BDS/printers | **PARTIAL** | KOT as distinct printable ticket + printer management (P0 #7), KDS urgency thresholds (P0 #8), BDS station typing (P1) |
| Phase 5 — Inventory + recipes + costing | **MOSTLY DONE** | Join recipe cost into reports for per-item margin (P0 #4), branch-scoped inventory + transfers (P1) |
| Phase 6 — Tables + floor plan + reservations | **PARTIAL** | Table status (P0 #1), floor plan editor (P0, same family), double-booking fix (P0 #3) |
| Phase 7 — Staff + attendance + expenses + finance | **MOSTLY DONE** | Shifts/leave (P2), expense receipts/recurring (P1), customer credit/due (P1) |
| Phase 8 — Advanced analytics | **PARTIAL** | Dashboard real KPIs (P0 #5), operations/customer analytics (P1), previous-period comparison (P1) |
| Phase 9 — Loyalty + coupons + CRM | **PARTIAL** | Coupons (P1, currently zero), customer self-service accounts (P0 #9) |
| Phase 10 — Website builder | **NOT STARTED** | Full build (P1) |
| Phase 11 — AI Restaurant Manager | **MOSTLY DONE** (Q&A slice) | Broaden data access (inventory/customers/reservations), forecasting, AI actions (P1/P2) |
| Phase 12 — Customer marketplace | **NOT STARTED** — blocked on Phase 9's customer accounts | — |
| Phase 13 — Discovery + reviews + offers | **NOT STARTED** | — |
| Phase 14 — Cross-restaurant loyalty | **NOT STARTED** | — |
| Phase 15 — SaaS billing + super admin | **PARTIAL** | DB-configurable plans, audit-log viewer, restaurant lifecycle management (P1) |
| Phase 16 — Security hardening | **MOSTLY DONE** | Redis-backed rate limiting before multi-instance deploy (P0) |
| Phase 17 — Performance optimization | **PARTIAL** | Real pagination beyond fixed caps (P1) |
| Phase 18 — End-to-end testing | **PARTIAL** | Real Playwright test suite (not just screenshot scripts), CI wiring (P0 #11) |
| Phase 19 — Production deployment | **NOT STARTED** | Dockerfile/deploy config, real hosting |

**Proposed near-term sequencing** (P0 items, roughly 4–6 focused phases):

- **Phase A** — Table status + floor plan foundation, reservation
  double-booking fix (P0 #1, #3 — these are related: both need a real
  table-state model).
- **Phase B** — Discounts, service charge, tips as first-class order/
  payment concepts, flowing through pricing, receipts, and reports (P0 #2).
- **Phase C** — Dashboard real KPIs + per-item margin in reports (P0 #4,
  #5 — cheap, mostly wiring existing data together).
- **Phase D** — POS workflow completeness: hold/resume order, table
  transfer (P0 #6).
- **Phase E** — KOT/printing + KDS urgency thresholds (P0 #7, #8).
- **Phase F** — Customer self-service accounts + first email notifications
  (P0 #9, #10) — the foundation the whole customer-platform vision (§22–26,
  §62–63 of the spec) depends on.
- **Ongoing** — CI wiring (P0 #11) can land in parallel with any of the
  above; it's small and independent.

This sequencing front-loads the items that are both P0 *and* cheap/
foundational (table status, dashboard/margin wiring) before the larger new
subsystems (discounts, customer accounts), and deliberately defers
Phases 10/12/13/14 (website builder, marketplace, discovery,
cross-restaurant loyalty) until the customer-accounts foundation (Phase F)
exists, since all four genuinely depend on it.

---

## 6. What was explicitly NOT touched by this audit

This document is research only — no code was changed. Every "MISSING"
finding above was confirmed by reading actual source and, where relevant,
grepping the full repository for the relevant terms (not inferred from
absence of a mention). Where a finding could be read as "the agent didn't
look hard enough," the underlying sub-audit reports (available in this
session's history) include the specific grep patterns and file line
numbers used to confirm each gap.
