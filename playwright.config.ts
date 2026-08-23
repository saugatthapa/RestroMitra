import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "fs";

/**
 * Phase 2 (P1) — E2E tests for the highest-value flows: owner login, QR
 * customer order placement, staff order management, and the reservation
 * flow. See e2e/README.md for scope/rationale and e2e/db.ts for how test
 * data is seeded/torn down.
 *
 * Loaded here (not in a setupFiles hook) because this file — playwright.config.ts
 * — is evaluated once in the root Playwright process before workers are
 * forked and before the webServer child process is spawned, so mutating
 * process.env here is inherited by both. Same loadEnvFile pattern as
 * test/setup-env.ts (vitest's equivalent) so `DATABASE_URL`/`DIRECT_URL`
 * from .env.local reach the e2e specs' direct `@/db` seeding calls, not
 * just the Next dev server (which loads .env.local on its own regardless).
 */
try {
  process.loadEnvFile(".env.local");
} catch {
  // No .env.local — DB-backed specs will fail loudly with "DATABASE_URL is
  // not set" from src/db/index.ts, same failure mode as `npm test`.
}

const PORT = process.env.E2E_PORT ?? "3100";
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;
const isCI = !!process.env.CI;

// This sandbox ships a Chromium build pre-baked at a fixed path
// (/opt/pw-browsers/chromium) that doesn't necessarily match the exact
// revision @playwright/test's package.json pins — `npx playwright install`
// is disabled here (network-restricted image), so pointing launchOptions
// at that prebuilt binary directly is the documented way to use it rather
// than downloading. Elsewhere (CI, a real dev machine) that path won't
// exist, so this only applies when it's actually there — everywhere else
// falls through to Playwright's normal browser resolution (after `npx
// playwright install chromium`, which ci.yml runs before this suite).
const SANDBOX_CHROMIUM = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? "/opt/pw-browsers/chromium";
const launchOptions = existsSync(SANDBOX_CHROMIUM) ? { executablePath: SANDBOX_CHROMIUM } : {};

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  // Each spec file seeds its own restaurant(s) with random-suffixed
  // slugs/phones (see e2e/db.ts), the same tenant-isolation-by-randomness
  // pattern the src/db/__tests__/ integration tests already rely on, so
  // running spec files concurrently is safe — no shared mutable fixture.
  workers: isCI ? 2 : undefined,
  reporter: isCI ? [["github"], ["list"]] : "list",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    // This app's client-side "today" defaults (the Reservations date
    // picker, an Expenses form's default date, ...) are deliberately based
    // on the DEVICE's own clock/timezone, not the restaurant's configured
    // timezone (see src/lib/local-date.ts's doc comment) — a real staff
    // member's device is assumed to already be in the restaurant's
    // timezone. A default (UTC) headless browser breaks that assumption
    // and desyncs from every seeded restaurant's "Asia/Kathmandu" timezone
    // (found by running this suite for real: the reservations spec's
    // freshly-created reservation didn't show up under "today" — the
    // browser's UTC "today" and the server's Kathmandu-bucketed "today"
    // were different calendar days at the sandbox's actual test time).
    // Matches restaurants.timezone's own column default.
    timezoneId: "Asia/Kathmandu",
    locale: "en-US",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], launchOptions } }],
  webServer: {
    // Always `next start` against a production build (see the `test:e2e`
    // script in package.json, which builds first) — not `next dev`.
    // Tried dev mode first, for a faster local edit/rerun loop, but
    // dropped it after actually running this suite repeatedly against
    // this project: Next 15.5.23's dev server, under this suite's own
    // concurrent request load (a page's parallel sub-resource/RSC
    // requests hitting still-compiling routes), intermittently served a
    // corrupted dev manifest — "SyntaxError: Unexpected end of JSON
    // input" server-side — failing whichever spec happened to hit it,
    // non-deterministically, even against an otherwise-healthy .next
    // cache. `next start` serves pre-compiled, immutable output with no
    // such race, and it's what ships — strictly more representative of
    // production for a suite whose whole job is catching real breakage.
    // The cost is that a local run needs a build first too, same as CI.
    command: `npx next start -p ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !isCI,
    timeout: 120_000,
  },
});
