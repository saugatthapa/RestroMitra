/**
 * Phase 2 (P1) — edge-runtime Sentry init, loaded from instrumentation.ts's
 * register() when NEXT_RUNTIME === "edge" (this app has no middleware.ts
 * today, so nothing currently runs in the edge runtime, but Next still
 * imports this file's existence into account when it does exist — kept
 * for when/if that changes, same reasoning next.config.ts's CSP module
 * comment gives for keeping HSTS/CSP broad rather than route-specific).
 * Inert with no SENTRY_DSN set — see instrumentation-client.ts's comment.
 */
import * as Sentry from "@sentry/nextjs";
import { redactEvent } from "@/lib/sentry-redact";

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.1,

    dataCollection: {
      httpBodies: [],
      cookies: false,
    },

    beforeSend(event) {
      return redactEvent(event);
    },
  });
}
