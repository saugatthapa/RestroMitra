# E2E tests (Playwright)

Phase 2 (P1) deliverable. Real browser tests against a real running server
and a real Postgres database — not mocked, not a unit test with a fixed
clock. Everything in this suite was actually run (repeatedly, against both
this project's dev database and a genuinely fresh scratch database
simulating CI) before being considered done; see P1_PHASE_REPORT.md for
what that surfaced.

## Scope

Four flows, chosen as the highest-value/most-likely-to-silently-break, not
as exhaustive coverage of every route in the master prompt's audit:

- **`owner-login.spec.ts`** — an owner logging into their own dashboard
  (the real `/login` page, `POST /api/auth/login`, session-cookie
  issuance, and the dashboard layout's redirect/subscription-access
  logic), plus the wrong-password path.
- **`qr-order.spec.ts`** — a guest scanning a table's QR code and placing
  a real order with no login, exactly as `src/app/order/[token]/page.tsx`
  describes its own access model.
- **`staff-order-management.spec.ts`** — the seam between "a guest just
  placed this order" and "staff, scoped to this restaurant, can see and
  advance it." Deliberately places the order through the real public flow
  first rather than seeding an order row directly — that seam (branch
  scoping, permissions) is exactly the kind of thing that can break
  silently without ever showing up in a route-handler-only test.
- **`reservations.spec.ts`** — staff creating a table reservation. This is
  the flow the P0-6 restaurant-timezone fix (`restaurantStartOfDay` in
  `src/lib/tables.ts`) protects; only a real browser clock (not a unit
  test with a fixed `Date`) can catch a UTC-vs-Kathmandu regression here
  the way a real user would experience it.

Not covered here (explicitly out of scope for this pass, not forgotten):
POS/offline flows, KDS, inventory/purchasing, payroll, payment gateway
checkout (eSewa/Khalti — already covered by the existing gateway-callback
integration tests), the website builder, multi-branch switching. Scope
realistically rather than aspirationally — see task #150's own note.

## How data is seeded

`db.ts` seeds each spec's own restaurant/branch/owner directly via
Drizzle (`@/db`), with a random suffix per run — the same
tenant-isolation-by-randomness pattern the integration tests in
`src/db/__tests__/` already use, so spec files never collide even when run
concurrently. Every spec tears down exactly what it created in
`afterAll`. There is no separate "e2e" database for local/CI runs — this
shares the same Postgres the vitest integration tests use
(`DATABASE_URL`/`DIRECT_URL`).

## Running

```bash
npm run test:e2e        # builds (next build), then runs the suite against `next start`
npx playwright test     # skip the build if you already have a fresh one
```

Requires `DATABASE_URL`/`DIRECT_URL` (from `.env.local` locally, or
ci.yml's Postgres service container in CI) and a migrated + seeded
database (`npm run db:migrate && npm run db:seed`) — every spec's seeded
"owner" role needs the real `role_permissions` reference data to pass any
RBAC check, same dependency `MIGRATION_SAFETY.md` documents for the rest
of the app.

### Why `next start`, not `next dev`

`playwright.config.ts`'s `webServer` always runs a production server, not
a dev server — this was NOT the original design. Found by actually
running this suite repeatedly: Next 15.5.23's dev server, under this
suite's own concurrent request load, intermittently served a corrupted
dev manifest (`SyntaxError: Unexpected end of JSON input` server-side),
non-deterministically failing whichever spec happened to hit it. `next
start` serves immutable pre-compiled output with no such race, and it's
what actually ships. The cost is that every run needs a build first
(`npm run test:e2e` does this for you); CI runs its own `npm run build`
step before the E2E step for the same reason (see `.github/workflows/ci.yml`).

### Timezone

The browser context is pinned to `Asia/Kathmandu` (this app's
`restaurants.timezone` column default) in `playwright.config.ts`. This
app's client-side "today" defaults are deliberately based on the device's
own clock (see `src/lib/local-date.ts`'s doc comment — a real staff
member's device is assumed to already be in the restaurant's timezone); a
default-UTC headless browser breaks that assumption and desyncs from the
server's Kathmandu-bucketed "today" queries. Found the same way as the
`next start` issue above — by actually running the reservations spec and
watching a just-created reservation fail to show up under "today."
