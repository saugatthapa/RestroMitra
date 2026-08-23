/**
 * Phase 2 (P1) — client-side Sentry init. Next.js 15.3+'s own
 * `instrumentation-client.ts` convention (loaded automatically, before
 * the rest of the app boots, no wiring needed elsewhere) — this replaces
 * the older `sentry.client.config.ts` file some Sentry docs/examples
 * still show.
 *
 * A no-op with no SENTRY_DSN set — this is deliberate, not a placeholder
 * left half-configured: I cannot create a Sentry account/project on this
 * project owner's behalf, so error monitoring has to ship in an inert
 * state until they set the env var themselves. See SENTRY_SETUP.md for
 * exactly what to do. `Sentry.init` is only called when a DSN is present;
 * every export below stays valid (and harmless) either way.
 */
import * as Sentry from "@sentry/nextjs";
import { redactEvent } from "@/lib/sentry-redact";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,

    // Traces: low sample rate in production (this is a real, paid-per-
    // event pipeline — no reason to trace every request) but full
    // sampling locally so tracing bugs are easy to reproduce during
    // development. No session replay, no user-feedback widget — this app
    // shows customer names/phones/payment state on screen throughout the
    // dashboard; recording DOM/session video would be a much bigger PII
    // surface than plain error capture, and nobody asked for it.
    tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.1,

    // See src/lib/sentry-redact.ts's own doc comment for the full
    // reasoning — request/response bodies and cookies are disabled
    // outright rather than trusted to per-event redaction alone.
    dataCollection: {
      httpBodies: [],
      cookies: false,
    },

    beforeSend(event) {
      return redactEvent(event);
    },
  });
}

export const onRouterTransitionStart = dsn ? Sentry.captureRouterTransitionStart : undefined;
