/**
 * Phase 2 (P1) — error-monitoring redaction rules, shared by all three
 * Sentry init files (instrumentation-client.ts, sentry.server.config.ts,
 * sentry.edge.config.ts) via their `beforeSend`/`beforeSendTransaction`
 * hooks.
 *
 * This is deliberately a second, independent layer on top of Sentry's own
 * `dataCollection` init option (see those files — request/response bodies
 * are disabled outright, cookies are disabled outright). `dataCollection`
 * is the primary control; this module is the backstop for whatever gets
 * through anyway — client-side breadcrumbs (fetch/XHR/console
 * integrations capture URLs and, in some cases, argument values
 * regardless of the server-side data-collection settings), `extra`/
 * `contexts` data attached by `Sentry.setContext`/`captureException(err,
 * {extra})` call sites elsewhere in the app, and defense-in-depth in case
 * a future config change re-enables body collection without anyone
 * remembering this comment.
 *
 * Never trust client input — same principle as the rest of this app's
 * server-side validation — extended here to "never trust that upstream
 * config correctly excluded PII"; redact by matching on data shape/key
 * name, not by assuming an upstream toggle already handled it.
 *
 * What this app actually has that's sensitive enough to redact:
 *   - `password`/`passwordHash` — account credentials.
 *   - `phone`/`customerPhone`/`ownerPhone` — the login identifier AND a
 *     customer's real phone number (QR orders capture `customerPhone`).
 *   - `customerName` — a QR guest's real name.
 *   - `email` — owner/staff email.
 *   - `panVat` — a restaurant's tax ID (business PII, not sensitive to
 *     Anthropic/Sentry-viewer relationship, but no reason to keep it
 *     either).
 *   - Session cookies / the `Cookie`/`Set-Cookie`/`Authorization` headers
 *     — a leaked session cookie is a full account-takeover vector, not
 *     just a privacy concern.
 *   - The QR order token itself (`/order/[token]`, `qrToken`) — per that
 *     route's own doc comment, the token IS the access control for a
 *     public, unauthenticated ordering flow. It's not a "password" by
 *     name, so key-based redaction alone won't catch it; see
 *     `redactUrl` below for the path-based redaction that does.
 */

const REDACTED = "[Redacted]";

const SENSITIVE_KEY_PATTERN =
  /^(password|passwordhash|phone|customerphone|ownerphone|customername|email|panvat|cookie|set-cookie|authorization|token|tokenhash|qrtoken|sessionid|clientrequestid|bankname|bankaccountnumber|bankaccountholder)$/i;

/**
 * Recursively walks a plain-data structure (already-parsed JSON-like
 * data — objects/arrays/primitives, exactly what Sentry event payloads
 * are made of) and replaces any value whose key matches
 * SENSITIVE_KEY_PATTERN with a fixed placeholder. Non-plain values
 * (functions, class instances other than Array/plain Object) are left
 * untouched rather than risking a broken clone of something Sentry's own
 * internals expect.
 */
export function redactSensitiveData(value: unknown, depth = 0): unknown {
  if (depth > 12) return value; // guard against pathological/circular-ish structures
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveData(item, depth + 1));
  }
  if (value !== null && typeof value === "object" && value.constructor === Object) {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactSensitiveData(val, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Path-based redaction for the one piece of PII that lives in a URL
 * segment rather than a keyed field: the QR order token
 * (`/order/<token>` and `/api/order/<token>/...`). Matches a path
 * segment of 16+ base62-ish characters immediately after `/order/` —
 * deliberately narrow (only that one route family) rather than a broad
 * "redact anything token-shaped" rule, which would also strip UUIDs used
 * as ordinary (non-secret) resource ids elsewhere (`/dashboard/orders/
 * [orderId]`) and make error reports needlessly harder to debug.
 */
export function redactUrl(url: string): string {
  return url.replace(/(\/(?:api\/)?order\/)[A-Za-z0-9_-]{8,}/g, `$1${REDACTED}`);
}

/**
 * The shared `beforeSend` used by all three Sentry init files. Typed
 * loosely (not against @sentry/core's exact ErrorEvent/EventHint types)
 * so this module stays independently unit-testable without pulling in
 * the SDK — each init file's own `beforeSend(event, hint) { return
 * redactEvent(event); }` call site gets full type-checking from
 * Sentry.init's own signature regardless.
 */
export function redactEvent<T>(event: T): T {
  const next = { ...(event as unknown as Record<string, unknown>) };

  if (next.request && typeof next.request === "object") {
    const request = { ...(next.request as Record<string, unknown>) };
    delete request.cookies;
    if (request.headers && typeof request.headers === "object") {
      const headers = { ...(request.headers as Record<string, unknown>) };
      for (const key of Object.keys(headers)) {
        if (SENSITIVE_KEY_PATTERN.test(key)) delete headers[key];
      }
      request.headers = headers;
    }
    if (typeof request.url === "string") request.url = redactUrl(request.url);
    if (request.data !== undefined) request.data = redactSensitiveData(request.data);
    next.request = request;
  }

  if (next.extra) next.extra = redactSensitiveData(next.extra);
  if (next.contexts) next.contexts = redactSensitiveData(next.contexts);

  if (Array.isArray(next.breadcrumbs)) {
    next.breadcrumbs = next.breadcrumbs.map((crumb) => {
      if (!crumb || typeof crumb !== "object") return crumb;
      const c = { ...(crumb as Record<string, unknown>) };
      if (typeof c.message === "string") c.message = redactUrl(c.message);
      if (c.data) c.data = redactSensitiveData(c.data);
      return c;
    });
  }

  return next as T;
}
