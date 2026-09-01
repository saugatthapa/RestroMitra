/**
 * Phase 2 (P1) — Next.js's server-startup hook (stable in this project's
 * pinned Next 15.5.23, no `experimental.instrumentationHook` config flag
 * needed — confirmed by reading node_modules/next/dist/server/next-
 * server.js directly rather than trusting a docs snapshot, per this
 * project's own AGENTS.md warning about the version drift between what's
 * pinned here and what any given doc page currently describes).
 *
 * Loads the runtime-appropriate Sentry init file. `onRequestError` wires
 * server-side errors from Server Components/Route Handlers/middleware
 * into Sentry too (not just uncaught exceptions that bubble to
 * global-error.tsx) — a no-op the same way the init files below are: it
 * only actually reports anywhere once SENTRY_DSN is set (Sentry.init
 * never having run means Sentry.captureRequestError has nothing to send
 * to).
 */
import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }

  // Gap-audit P0 fix — every init file above is a deliberate, silent no-op
  // without SENTRY_DSN (see their own doc comments), which is correct
  // behavior locally/in CI but was never actually surfaced to anyone
  // running this in production without having set it up — a real
  // production incident could go completely unreported with no signal
  // anywhere that monitoring was off. Gated on NODE_ENV === "production"
  // specifically so it never fires in local dev (NODE_ENV=development) or
  // under the test suite (vitest's default NODE_ENV=test, never overridden
  // by this repo's vitest.config.mts or test/setup-env.ts) — register()
  // itself is also only ever invoked by the real Next.js server runtime,
  // never imported by any test file. Checks the server-side SENTRY_DSN
  // only (not NEXT_PUBLIC_SENTRY_DSN, a browser-side concern this
  // server-startup hook has no visibility into) since the setup docs this
  // points at have the caller set both together anyway. register() runs
  // once per server process at boot (nodejs runtime; separately for edge,
  // if this app ever adds middleware/edge routes), so this warns at most
  // once per process start, not per-request.
  if (process.env.NODE_ENV === "production" && !process.env.SENTRY_DSN) {
    console.warn(
      "[RestroMitra] Error monitoring is DISABLED: SENTRY_DSN is not set in this " +
        "production environment, so errors will not be reported anywhere. " +
        "See SENTRY_SETUP.md at the repo root for how to turn this on.",
    );
  }
}

export const onRequestError = Sentry.captureRequestError;
