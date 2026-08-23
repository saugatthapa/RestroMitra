/**
 * Phase 2 (P1) — server-side (Node.js runtime) Sentry init, loaded from
 * instrumentation.ts's register() when NEXT_RUNTIME === "nodejs". Inert
 * with no SENTRY_DSN set — see instrumentation-client.ts's own comment on
 * why, and SENTRY_SETUP.md for what the project owner needs to do to turn
 * this on for real.
 */
import * as Sentry from "@sentry/nextjs";
import { redactEvent } from "@/lib/sentry-redact";

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.1,

    // See src/lib/sentry-redact.ts's own doc comment. Request/response
    // bodies and cookies are disabled outright here, not just filtered
    // after the fact — every mutating route in this app touches either
    // customer PII (name/phone on a QR order) or credentials (password on
    // login/register), so "collect everything, redact the known-bad
    // keys" is backwards for this app; "collect nothing extra, let
    // redactEvent catch stragglers (extra/contexts/breadcrumbs)" is the
    // safer default.
    dataCollection: {
      httpBodies: [],
      cookies: false,
    },

    beforeSend(event) {
      return redactEvent(event);
    },
  });
}
