/**
 * Gap-audit P1 fix (Finding 3) — a minimal in-memory recent-errors ring
 * buffer, feeding the platform admin console's "recent alerts" list.
 *
 * Sentry (see instrumentation.ts / sentry.server.config.ts) is this app's
 * real error-tracking system, but it's an EXTERNAL service this app has no
 * read access back into (no Sentry API token/org configured here, and
 * building that integration is out of this fix's pragmatic scope — see
 * the audit finding's own "in-app alert list is sufficient" guidance).
 * toErrorResponse() (api-route-helpers.ts) is the one choke point ~76 API
 * routes already funnel every unhandled error through on its way to
 * Sentry.captureException — this module taps that same call site to also
 * keep the last MAX_ENTRIES in process memory, so the admin console can
 * show "what broke recently" without needing Sentry's dashboard at all.
 *
 * CAVEAT (same one rate-limit.ts already documents for this app's other
 * in-memory store): this only works within a single Node.js process. Fine
 * for this project's single-instance deployment target (see
 * request.ts's TRUSTED_PROXY_COUNT comment for that deployment shape);
 * a multi-instance deployment would need a shared store instead. Also
 * lost on every restart/deploy — acceptable for "recent alerts," which is
 * inherently a rolling window, not a permanent audit record (recordAuditLog
 * remains the durable trail for anything that needs one).
 */

export type SystemErrorEntry = {
  message: string;
  createdAt: Date;
};

const MAX_ENTRIES = 200;
const MAX_MESSAGE_LENGTH = 500;

let entries: SystemErrorEntry[] = [];

function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name || "Unknown error";
  if (typeof err === "string") return err;
  try {
    // JSON.stringify returns the actual `undefined` value (not the string
    // "undefined") for undefined/functions/symbols — falling through to
    // "Unknown error" here, rather than letting that undefined reach the
    // caller's .slice() call, is what keeps a `throw undefined` from being
    // silently dropped instead of recorded.
    return JSON.stringify(err) ?? "Unknown error";
  } catch {
    return "Unknown error";
  }
}

/** Records one unhandled error. Never throws — a logging failure must never break the error response it's attached to. */
export function recordSystemError(err: unknown): void {
  try {
    const message = toMessage(err).slice(0, MAX_MESSAGE_LENGTH);
    entries.push({ message, createdAt: new Date() });
    if (entries.length > MAX_ENTRIES) {
      entries = entries.slice(entries.length - MAX_ENTRIES);
    }
  } catch {
    // Never let error-logging itself throw.
  }
}

/** Most recent unhandled errors, newest first. */
export function listRecentSystemErrors(limit = 50): SystemErrorEntry[] {
  return entries.slice(Math.max(0, entries.length - limit)).reverse();
}

/**
 * Dismisses the whole in-memory list from the admin "Recent alerts" panel.
 * Distinct from `_resetSystemErrorLogForTests` (test-only, unexported from
 * the public API surface this route calls) even though the body is
 * identical — this one is a real, audited admin action (see
 * /api/admin/alerts's DELETE handler), not test plumbing, and keeping them
 * separate means a rename of either one doesn't silently affect the other.
 */
export function clearSystemErrors(): void {
  entries = [];
}

/** Test-only reset — keeps tests in this file's own module scope from leaking state into each other or into unrelated test files that happen to run in the same process. */
export function _resetSystemErrorLogForTests(): void {
  entries = [];
}
