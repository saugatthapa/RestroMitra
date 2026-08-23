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
}

export const onRequestError = Sentry.captureRequestError;
