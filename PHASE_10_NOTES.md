# Phase 10 — SaaS Plans, Trials, Subscriptions & Platform Admin

With Phase 9 complete (analytics & reports), every operational module a restaurant
actually runs on is now shipped. Phase 10 turns DhankiPOS from "an app restaurants
use" into an actual SaaS product: real trial expiry that blocks access, a plan
catalog, a billing page owners can act on, and a platform admin console for running
the business behind the business.

## Competitive context

restrohub.com.np and most of this tier either don't expose a self-serve billing
surface at all (subscriptions are handled entirely off-platform, by phone/WhatsApp)
or don't enforce trial expiry in the product itself. This phase ships both ends of
that loop in the app: a real 30-day trial that actually blocks a dashboard once it
lapses (not just a banner nobody enforces), a `/billing` page that explains exactly
why and lets an owner request a plan, and a platform admin console to fulfill that
request and manage every tenant's subscription state — the operational tooling a
one-person or small team running this as an actual business needs on day one.

## What's done and verified

- **Schema**: `plan_key` enum (`starter`/`growth`/`pro`) added to `restaurants`
  (nullable — no plan assigned yet is a valid, common state, distinct from "on the
  free trial"), and a new `subscription_events` table — an append-only ledger
  (`trial_started`, `trial_extended`, `trial_expired`, `upgrade_requested`,
  `plan_assigned`, `plan_changed`, `activated`, `past_due_marked`, `cancelled`,
  `reactivated`) recording `fromStatus`/`toStatus`/`planKey`/`note`/who performed
  it (`null` = system-generated). Same ledger-over-mutable-field pattern this
  project has used since the payments/stock-movements/loyalty-transactions tables —
  `restaurants.subscription_status` is the fast-read snapshot, `subscription_events`
  is the auditable history explaining how it got there.
- **`src/lib/plans.ts`** (pure) — the plan catalog: Starter (Rs 1,500/mo, 5 staff),
  Growth (Rs 3,500/mo, 15 staff, "Most popular"), Pro (Rs 6,500/mo, unlimited
  staff). Pricing is explicitly commented as a placeholder to update before any real
  payment is taken — there's no payment gateway in this phase (see Known gaps).
  `maxStaffForRestaurant` falls back to a generous 10-staff trial default when no
  plan is assigned yet, so a brand-new signup isn't immediately staff-constrained
  before they've even chosen a plan.
- **`src/lib/subscription.ts`** (pure) — `computeSubscriptionAccess`: the single
  source of truth for "can this restaurant use the product right now," derived
  purely from `subscriptionStatus` + `trialEndsAt` vs. the current time (no DB
  read). `active`/`past_due` always allowed (past-due is a grace period — nothing in
  this phase automatically marks a restaurant past-due, since there's no payment
  gateway to fail a charge; it exists as an admin action for the day one exists).
  `trialing` is allowed until `trialEndsAt`, then blocked with reason
  `trial_expired`. `cancelled`/`expired` always blocked. An unrecognized status
  fails **closed** (blocked), not open — a safety choice over silently granting
  access to a state the code doesn't know about.
- **`src/lib/subscription-db.ts`** (server-only) — `reconcileSubscriptionStatus`:
  the lazy self-healing write. There's no cron infrastructure in this app, so
  instead of a scheduled job flipping expired trials, the very next request that
  touches a lapsed-trial restaurant does it inline — one `db.transaction` updating
  `subscription_status` to `expired` and appending a `trial_expired` event, exactly
  once (verified by an integration test asserting a second call makes no additional
  write). Every subsequent read just sees the already-updated status.
- **Enforcement chokepoint**: `requireActiveSubscription` (new in `guard.ts`) is
  called from inside `resolveRestaurantContext` — the single function every
  tenant-scoped API route already goes through — right after resolving the caller's
  role, before the permission check. `platform_admin` bypasses it unconditionally
  (an admin must always be able to reach a blocked tenant's data to fix it,
  regardless of that tenant's own billing state — covered by a dedicated
  integration test). Routes that must stay reachable even while blocked (billing
  GET, the upgrade-request POST) opt out via `resolveRestaurantContext(slug, perm,
  { allowInactiveSubscription: true })`.
- **`requirePlatformAdmin()`** (new in `guard.ts`) — `platform_admin` is a
  `user_roles` row with `restaurantId: null`; this throws a 403 `AuthError` for
  anyone else. There's deliberately no self-serve way to become a platform admin —
  it's granted directly in the database, the same trust boundary a real ops team
  would use.
- **`src/app/dashboard/layout.tsx`**: redirects to `/billing` when
  `computeSubscriptionAccess` says the active restaurant is blocked (skipped for
  `platform_admin`). `/billing` is deliberately a **top-level** route, not nested
  under `/dashboard`, specifically so this redirect can never loop.
- **API routes**: `GET /api/restaurants/[slug]/billing` (status, trial countdown,
  current plan, last 20 events — open to any active staff member, not just
  `MANAGE_SUBSCRIPTION` holders, so everyone can see *why* they were redirected);
  `POST .../billing/upgrade-request` (`MANAGE_SUBSCRIPTION`-gated, i.e. owner-only —
  logs an `upgrade_requested` event only, does **not** change plan/status itself,
  since there's no payment gateway yet — mirrors a realistic pre-self-serve-checkout
  "request, then a human fulfills it" flow); `GET /api/admin/restaurants`
  (`?status=`/`?q=` filtered platform-wide list, `platformAdmin`-gated); `GET
  /api/admin/restaurants/[id]` (full detail: owner, staff count, plan, last 50
  events); `PATCH /api/admin/restaurants/[id]/subscription` (the single choke point
  for every admin-driven state change — extend trial, assign+optionally-activate a
  plan, mark past due, cancel, reactivate — each updates the restaurant row and
  appends a `subscription_events` row in one transaction, plus a generic
  `audit_logs` entry).
- **Staff-seat plan limits**: the staff-invite `POST` route now checks
  `maxStaffForRestaurant` against the restaurant's assigned plan and rejects a new
  non-owner invite at the cap with a clear "upgrade your plan" message. The owner
  themself doesn't count against their own plan's seat allowance.
- **`/billing`** (`BillingBoard.tsx`) — status banner (color-coded by status),
  trial countdown / current-plan / past-due / cancelled messaging, a blocked
  callout when access is denied (text differs for the owner vs. everyone else), a
  3-plan grid with a "Request this plan" action that tracks and reflects a
  just-submitted request, and a recent-activity timeline.
- **`/admin`** (platform-admin-only layout + overview) — 5 stat tiles
  (total/trialing/active/past-due/expired+cancelled), a name/slug search plus
  status filter, and a restaurant table linking to each tenant's detail page.
  **`/admin/restaurants/[id]`** — overview (owner, staff count, plan, trial end,
  created date), the full action panel (note field shared across actions; extend
  trial by N days; assign a plan with an activate-immediately checkbox; mark past
  due / reactivate / cancel), and the subscription event timeline.
- **Onboarding**: `POST /api/onboarding/restaurant` now logs a `trial_started`
  event inside the same transaction that creates the restaurant and the owner's
  role — the ledger's first entry exists from the very first request, not
  backfilled later.
- **Tests**: `src/lib/subscription.test.ts` (14 cases — every status/allowed
  combination, the exact-boundary instant, `daysRemaining` rounding and its
  never-negative floor, fail-closed on an unrecognized status), `src/lib/plans.test.ts`
  (9 cases — catalog invariants, strictly increasing prices, `getPlanByKey`,
  `maxStaffForRestaurant`'s trial-default fallback), and
  `src/db/__tests__/subscription-permissions.test.ts` (8 DB-backed integration
  cases — the lazy reconciliation's exactly-once write against a real Postgres row,
  a cancelled restaurant needing zero reconciliation writes since it's already
  terminal, `isPlatformAdmin` true/false, the `platform_admin` bypass working
  against an *expired* tenant, and `MANAGE_SUBSCRIPTION` being owner-only). 291
  tests total after this phase (up from 260), all passing.
- **Live smoke test** (`scripts/smoke-test-phase10.sh`, 29 assertions, all
  passing) — the full lifecycle over real HTTP against the real dev server: trial
  start logged at onboarding, a lapsed trial actually returning 402 and flipping
  the DB row exactly once, `/billing` staying reachable while blocked, the
  **dashboard page itself** redirecting a blocked tenant to `/billing` (verified via
  the `Location` response header, not just the guard function in isolation), every
  admin action (extend/assign+activate/mark-past-due/cancel/reactivate) each
  re-verified against a real tenant-scoped route's status code afterward, staff-seat
  enforcement (exactly 5 non-owner staff allowed on Starter, the 6th rejected with
  the upgrade-prompting message), the upgrade-request flow and its owner-only
  permission gate, a platform admin's unconditional access to a cancelled tenant,
  and cross-tenant isolation on both billing and admin routes.
- **Playwright screenshots** (`scripts/screenshot-phase10.mjs`, all entity names
  prefixed `Phase10Tour`) — `/billing` in a healthy trialing state, `/billing`
  blocked with the expired banner and a plan just requested, the `/admin` overview
  with a real mix of trialing/active/expired tenants, and the `/admin/restaurants/
  [id]` detail page with a full action panel and populated event timeline —
  all visually verified.

## Known gaps / deliberately deferred

- **No payment gateway, no real pricing.** Every price in `plans.ts` is explicitly
  commented as a placeholder. Plan assignment and activation today only happen
  through the admin console's manual actions — there's no checkout flow, and an
  owner's "Request this plan" only logs an event for a human to act on.
- **`past_due` is never set automatically.** With no payment gateway, nothing fails
  a charge, so `mark_past_due` exists purely as an admin action today — wiring a
  real gateway's webhook (failed charge → `mark_past_due`, successful retry →
  `reactivate`) is Phase 11+ territory.
- **Plan limits currently cover staff seats only** — not branches, tables, or menu
  items. A multi-branch cap tied to plan tier is a natural extension once Phase 11's
  multi-branch work lands.
- **No expiry-warning notifications.** A trial silently expires from the owner's
  point of view until they next hit a blocked page; there's no "your trial ends in
  3 days" email/SMS yet (no notification infrastructure exists in this app at all).
- **No self-serve plan switching for an already-active subscriber** — downgrading
  or upgrading between paid plans still routes through the same
  request-then-admin-fulfills flow as a trial's first plan choice.

## Next steps

1. Move on to **Phase 11 (Offline POS, payment integrations, multi-branch, AI
   assistant)** per the original roadmap — this is the last phase in the plan.
2. Consider the "Known gaps" above — a real payment gateway integration in
   particular — as the natural home for turning `past_due`/plan-switching from
   admin-manual into automatic.
3. Same standing item as every phase: run this against a real Supabase project once
   live credentials are available.
4. Push to GitHub from your machine.
