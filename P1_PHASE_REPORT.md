# RestroMitra — Phase 2 (P1) Production Hardening: Interim Report

**Scope of this report:** the 6 P1 items from your master prompt — security headers, rate limiting, CI/CD, backup/restore, migration safety, E2E testing — plus error monitoring, which the earlier task breakdown grouped into this phase too. Phase 3 (P2: cash register, COGS, supplier dues, wastage tracking, stock count, branch transfer, payroll) has **not been started** — not raised or approved yet, per the same "don't touch P2 until P0/P1 are stable" discipline as the P0 report.

Same rule as last time: everything below was verified by actually running the commands shown, not inferred. Two things in this pass specifically surfaced *because* I ran them for real rather than trusting a plausible-looking config — both are called out below, not glossed over.

## 1. Production security headers (CSP, HSTS, etc.)

`next.config.ts` now sets Content-Security-Policy, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, and Strict-Transport-Security on every route.

Deliberately the "Without Nonces" CSP pattern, not nonce-based strict CSP — a nonce-based CSP forces every page (the public QR menu, the print/KOT page, `/login`/`/register`, the public restaurant website builder) off static optimization, and this codebase has 30+ inline `style={{}}` usages that a nonce-based `style-src` would break outright. `script-src`/`style-src` keep `'unsafe-inline'` — a real, explicitly-acknowledged gap in XSS defense-in-depth, not something to pretend away — while every other directive is as strict as the actual codebase allows (verified: no `dangerouslySetInnerHTML`, no inline `<script>` tags, no third-party analytics/tracking scripts). `form-action` explicitly allow-lists eSewa's hosted checkout host (both prod and staging) since `GatewayPaymentButtons.tsx` does a real cross-origin form POST there — a bare `form-action 'self'` would have silently broken real payments. HSTS is set without `preload` on purpose (a hard-to-reverse, domain-wide commitment that should be the domain owner's explicit choice).

Verified against the framework version actually pinned here, not against whatever docs.nextjs.org's default page currently shows — the *current* Next.js docs describe a renamed `proxy.ts` (Next 16.x) that doesn't apply to this app's Next 15.5.23; fell back to the v14-specific snapshot instead, which correctly still documents `middleware.ts`/`next.config.js` `headers()`.

8 tests in `src/security-headers.test.ts` lock in the CSP baseline, the eSewa allow-list, and every other header — specifically to catch someone accidentally loosening `frame-ancestors`/`object-src` or dropping the eSewa allowance later without noticing.

**Caveat I can't verify from this sandbox:** whether Hostinger's reverse proxy passes these response headers through unmodified. Confirm with the browser Network tab against the live deployment.

## 2. Rate limiting review

Reviewed `src/lib/rate-limit.ts` and its call sites (login, register — 20/60s by IP, 8/60s by phone). The mechanism itself is sound for a single-instance deployment (in-memory, sliding window). No code changes made — this was a review, and I'm not going to manufacture a change just to have one. The one real limitation worth flagging: it's in-memory, so it resets on every deploy/restart and wouldn't coordinate across multiple instances if this ever moves off a single Hostinger box. Not a problem today; worth remembering if the deployment topology changes.

## 3. CI/CD (GitHub Actions)

`.github/workflows/ci.yml` — triggers on push/PR to `main`, runs against a real `postgres:16` service container so the DB-backed integration tests actually run (not skip themselves for lack of `DATABASE_URL`). Steps, in order: checkout, Node 22, `npm ci`, lint, typecheck, `db:migrate`, `db:seed`, `vitest run`, `npm run build`, install Playwright's Chromium, E2E tests.

**Two real, previously-invisible problems found by actually simulating this workflow against a genuinely fresh scratch database**, not by writing plausible-looking YAML and assuming it works:

- **APP_URL mismatch.** The gateway-callback integration tests hardcode `http://localhost:3100` and assert the exact resulting redirect URL (built server-side from `process.env.APP_URL`); my first guess (`:3000`) failed 2 tests. Fixed.
- **Missing seed step.** `role_permissions` (which role gets which permission) is deliberately seeded separately from the schema migrations (`src/db/seed.ts`), not baked into a migration — a migrated-but-unseeded database has no permission grants at all. Every permission-check test (13 of them) failed until I added the seed step. This is now also called out explicitly in `MIGRATION_SAFETY.md` as a real disaster-recovery/new-environment gotcha, not just a CI fix.

Re-ran the full simulated workflow after both fixes: clean.

## 4. Database backup/restore (`BACKUP_RESTORE.md`)

Documents Supabase's actual tier-dependent backup/PITR features (researched live against Supabase's current docs — Free tier has **no** automatic backups at all; Pro/Team/Enterprise get daily backups with 7/14/30-day retention; PITR is a separate paid add-on) and the manual `pg_dump`/`pg_restore` procedure using `DIRECT_URL` (not the pooled `DATABASE_URL`).

**Action item I can't resolve from this sandbox:** which Supabase plan this project is actually on. If it's Free, the manual procedure in that doc is the *entire* backup strategy today, not a supplement, and should run on a real schedule.

Actually executed end-to-end against a real snapshot of this project's dev database this session (not just described): `pg_dump` (606KB), restore into a genuinely separate scratch database, row counts on `restaurants`/`permissions`/`role_permissions` matched exactly (175/28/72), all 40 tables present, both P0-hardening partial unique indexes survived intact, a real restaurant row round-tripped correctly. Scratch DB and dump file cleaned up afterward.

Honestly flagged as not yet done: actual scheduling/automation of the backup (a cron-triggered GitHub Action or Hostinger scheduled task) — the doc recommends it as the real next step rather than claiming it's handled.

## 5. Migration safety (`MIGRATION_SAFETY.md`)

Tested against both a genuinely empty database (all 29 migrations applied cleanly, both P0-hardening indexes present, but see the seed-step finding above) and this project's real populated dev database (both new migrations from the P0 pass applied cleanly against real accumulated data — itself a positive proof no existing rows already violated either new partial-unique constraint). Documents a 4-step safe production migration procedure and an honest caveat: this wasn't tested against production-scale data volume, so a future `CREATE UNIQUE INDEX` against a much larger table deserves a dedicated check before running during business hours.

## 6. E2E testing (Playwright)

New `e2e/` suite, 5 tests across 4 specs — chosen as the highest-value, most-likely-to-silently-break flows, not exhaustive coverage of every route in your original audit (see `e2e/README.md` for the full scope list and what's deliberately excluded):

- **Owner login** — the real `/login` page → `POST /api/auth/login` → session cookie → dashboard layout's redirect/subscription-access logic, plus the wrong-password path.
- **QR customer order placement** — a guest scanning a table's QR code, browsing the real menu, and placing a real order with no login.
- **Staff order management** — deliberately places the order through the real public flow first, then switches to the owner logging in and confirming it on the Orders board, because the *seam* between "a guest just ordered" and "staff can see/act on it" (branch scoping, permissions) is exactly the kind of thing that breaks silently without ever showing up in a route-handler-only test.
- **Reservations** — staff creating a table reservation, the flow the P0-6 timezone fix protects.

Each spec seeds its own restaurant/branch/owner directly via Drizzle with a random suffix (same tenant-isolation-by-randomness pattern the existing `src/db/__tests__/` integration tests use) and tears down exactly what it created.

**Two real things found by actually running this suite repeatedly, not just once:**

- **Browser timezone.** This app's client-side "today" defaults (the reservations date picker, an expense form's default date) are deliberately based on the device's own clock, not the restaurant's configured timezone (a real staff member's device is assumed to already be in Nepal) — a default-UTC headless browser desyncs from every seeded restaurant's `Asia/Kathmandu` timezone and a just-created reservation silently didn't show up under "today." Fixed by pinning the Playwright browser context to `Asia/Kathmandu`.
- **Dev-mode flakiness.** Next 15.5.23's dev server, under this suite's own concurrent request load, intermittently served a corrupted dev manifest (`SyntaxError: Unexpected end of JSON input`) — non-deterministic, would have shown up as random CI flakes with no obvious cause. Switched the suite to always run against a production build (`next start`) instead of `next dev`; `npm run test:e2e` builds first, and `ci.yml` runs its own `Build` step before the E2E step for the same reason. Confirmed clean across multiple repeated full runs after the switch, both against this project's dev database and a genuinely fresh scratch database simulating what a real CI runner starts from.

Playwright's own pinned Chromium revision didn't match this sandbox's pre-baked browser binary — worked around via `launchOptions.executablePath` pointed at the sandbox's actual browser, falling through to Playwright's normal resolution (after `npx playwright install`, which `ci.yml` runs) everywhere else, including a real GitHub Actions runner.

## 7. Error monitoring (Sentry)

Wired up (`@sentry/nextjs`, `instrumentation.ts`, `instrumentation-client.ts`, `sentry.server.config.ts`, `sentry.edge.config.ts`) but **inert** — I can't create a Sentry account/project on your behalf, so this ships in an off state until you set the env vars. `SENTRY_SETUP.md` is the rest of this task: exactly what to do (create the project, which env vars go where, source-map upload is optional and separately gated).

**Redaction rules** (`src/lib/sentry-redact.ts`, 14 unit tests): request/response bodies and cookies are disabled at the SDK config level outright — not "collect everything, then filter the obviously-bad fields" — because nearly every mutating route in this app touches either customer PII (name/phone on a QR order) or credentials (password on login/register). A `beforeSend` hook is the backstop for whatever's left (breadcrumbs, `extra`/`contexts`): strips password/phone/customerName/email/panVat/cookies/session-id fields by key, and separately redacts the QR order token out of any captured URL — that token is a bearer credential by this app's own design (`/order/[token]`'s own doc comment), not something a generic "strip known field names" rule would catch since it lives in a URL path segment, not a keyed field.

CSP interaction that's easy to miss and would have silently broken this: `next.config.ts`'s `connect-src 'self'` (from item 1 above) would flatly block the Sentry browser SDK's default direct POST to `*.sentry.io` — not an edge case, the default behavior. Fixed via `tunnelRoute`, which routes error reports through this app's own origin instead.

**Verified, not assumed:** ran the full test suite, the E2E suite, and a full production build with zero Sentry env vars set (this sandbox's actual state) — confirmed nothing changed in the app's behavior; every `Sentry.init()` call is skipped outright when its DSN is unset.

**Honest trade-off, stated in `SENTRY_SETUP.md` rather than hidden:** the static `import * as Sentry from "@sentry/nextjs"` in `instrumentation-client.ts` (Sentry's own documented pattern) adds ~80KB to the client's shared JS bundle even while inert — measured via this session's own build (`First Load JS shared by all`: 103KB → 184KB). The `if (dsn)` guard stops anything from being *sent*, not from being *shipped*. Worth knowing before deciding whether/when to turn this on for a mobile-heavy audience on a single-instance deployment; a dynamic-import conversion is a real, well-scoped follow-up if that cost matters, not done this pass.

## Verification (all run for real, this session)

| Check | Result |
|---|---|
| `tsc --noEmit` | 0 errors |
| `npm run lint` | 0 errors, 6 warnings (all pre-existing, unrelated to this work) |
| `vitest run` (full suite) | **642/642 passing** (620 baseline + 8 security-header + 14 redaction tests) |
| `npm run build` | passing, with and without Sentry env vars set |
| E2E suite (`npm run test:e2e`) | **5/5 passing**, confirmed across multiple repeated fresh runs |
| CI workflow | dry-run simulated end-to-end against a fresh scratch database, twice (once before, once after the two fixes above) |
| Backup/restore | actually executed end-to-end (dump → restore → verify), not just documented |
| Migration safety | tested against both an empty DB and this project's real populated dev DB |

## Files touched

Net new: `.github/workflows/ci.yml`, `BACKUP_RESTORE.md`, `MIGRATION_SAFETY.md`, `SENTRY_SETUP.md`, `playwright.config.ts`, `e2e/` (README + 4 specs + shared DB fixture helper), `instrumentation.ts`, `instrumentation-client.ts`, `sentry.server.config.ts`, `sentry.edge.config.ts`, `src/lib/sentry-redact.ts` + test, `src/security-headers.test.ts`. Modified: `next.config.ts` (security headers + Sentry build wrapper), `package.json`/`package-lock.json` (`@playwright/test`, `@sentry/nextjs`, `test:e2e` script), `.env.example` (Sentry env var documentation), `.gitignore` (Playwright output dirs).

## What I have not done

Committed locally (`caeca4d`) but not pushed to GitHub — that's delivered alongside this report as a git bundle for you to pull in. Have not started Phase 3 (P2) — cash register/shift management, COGS reporting, supplier dues, wastage tracking, physical stock count, branch-to-branch transfer, payroll improvements. That's real, substantial work deserving its own focused pass and its own explicit go-ahead, same as this phase got.
