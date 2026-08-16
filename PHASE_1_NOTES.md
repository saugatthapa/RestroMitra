# Phase 1 — Foundation: status notes

Scope per the product spec: project setup, authentication, database, multi-tenancy,
roles, restaurant onboarding, basic dashboard.

## What's done and verified

- **Schema**: `users`, `sessions`, `restaurants`, `branches`, `permissions`,
  `role_permissions`, `user_roles`, `audit_logs`. Every tenant-owned table carries
  `restaurant_id` (and `branch_id` where relevant); no denormalized duplication.
- **Auth**: register / login / logout. Passwords hashed with bcrypt (cost 12,
  timing-safe comparison via a dummy hash on unknown users). Sessions are server-side
  rows (SHA-256 hash of a random token in an httpOnly cookie) — logout actually
  invalidates the session, not just the cookie.
- **RBAC**: seven system roles (`platform_admin`, `owner`, `manager`, `cashier`,
  `waiter`, `kitchen_staff`, `inventory_manager`) and 18 granular permissions
  (`view_sales`, `create_order`, `cancel_order`, `edit_price`, `manage_staff`, etc. —
  see `src/lib/rbac/permissions.ts`). `owner` and `platform_admin` bypass the
  permission table (they have everything); every other role is checked against
  `role_permissions`.
- **Tenant isolation**: `requireRestaurantAccess()` / `requirePermission()` /
  `requireBranchAccess()` in `src/lib/rbac/guard.ts` are the single choke point.
  They take a userId (from the verified session) and a restaurantId, and look up an
  **active** `user_roles` row — there is no other path to "prove" tenant access.
  Verified with a real Postgres database in `src/db/__tests__/tenant-isolation.test.ts`
  (9 tests: cross-tenant access denial for two different owners, branch-scoped staff
  denied access to a sibling branch, nonexistent restaurant IDs rejected, etc.)
- **Onboarding wizard**: 6-screen flow (name → type → address/phone → PAN/VAT →
  hours → review) that creates the restaurant, a main branch, and an `owner`
  `user_roles` row in a single DB transaction, sets a 30-day trial, and marks the
  session's active restaurant. Steps 9–13 from the full spec (tables, menu, QR codes,
  staff invites) are explicitly deferred to Phases 2/3/8 and shown as "coming soon" in
  the completion screen rather than half-built.
- **Dashboard shell**: authenticated, tenant-scoped shell with a sidebar nav (mostly
  disabled placeholders labeled with the phase that will light them up), a trial
  countdown badge, and a logout button. Proves the whole stack — auth → tenant
  resolution → protected rendering — works end to end.
- **End-to-end verified manually** against a real Postgres (see below): register →
  onboarding → dashboard render → logout → dashboard access correctly denied
  post-logout (307 redirect to `/login`).
- **Automated tests**: 26 passing (17 pure-logic unit tests + 9 DB-backed tenant
  isolation/RBAC integration tests). `npx tsc --noEmit` and `eslint` both clean.
  Production build (`next build`) succeeds.

## Known gaps / deliberately deferred

- **No live production database yet.** Development and verification so far used a
  local Postgres instance inside the build sandbox (migrations + seed run cleanly
  against it). You'll need to point `.env.local` at your actual Supabase project and
  re-run `npm run db:migrate && npm run db:seed` — this has NOT been run against
  Supabase specifically, only against vanilla Postgres 16, but there's no
  Supabase-specific behavior being relied on (it's just Postgres), so it should be a
  non-event.
- **No GitHub push yet.** The code lives in this local folder (synced via the device
  bridge) rather than a repo, per your choice to push from your own machine with your
  own credentials. See "Next steps" below.
- **CSRF/session hardening is Phase-1-appropriate, not exhaustive.** The custom-header
  check + SameSite cookies is solid defense-in-depth for now; revisit if you add
  server-rendered `<form>` POSTs anywhere (currently everything goes through the
  `fetch`-based `apiPost` helper, which always sets the header).
- **Rate limiting is in-memory / single-process.** Fine for one dev/staging instance;
  will silently stop being effective (not fail — just stop limiting) if you ever run
  multiple app instances behind a load balancer without swapping it for a shared store.
- **No password reset flow yet.** Not in the Phase 1 spec explicitly, but you'll want
  it before real users onboard. Flagging so it doesn't get forgotten.
- **Logo upload isn't implemented** — the onboarding schema has a `logoUrl` field
  ready for it, but there's no file upload step yet (needs object storage, e.g.
  Supabase Storage). Deferred rather than half-built.
- **Single active restaurant per session** — the schema supports a user owning/staffing
  multiple restaurants (`user_roles` is many-to-many), but the UI doesn't yet expose
  switching between them. Comes with multi-branch work later.

## Next steps

1. Give me your Supabase connection strings (or confirm you've set them up yourself in
   `.env.local`) and re-run migrations/seed against the real project.
2. `git init`, commit, and push this folder to the GitHub repo you create — you have
   your own credentials locally, so no token needs to change hands.
3. Once both are confirmed working, we start Phase 2 (menu: categories, items,
   variants, add-ons) on top of this foundation.
