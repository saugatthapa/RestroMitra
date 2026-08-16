/**
 * Small helper for recognizing a Postgres unique-violation (23505) thrown
 * from inside a drizzle query or `db.transaction()` callback.
 *
 * Found while building Phase 11b's order idempotency handling: drizzle-orm
 * wraps the underlying postgres.js error in a `DrizzleQueryError`, so the
 * real Postgres error code ends up on `err.cause.code`, NOT `err.code`. The
 * order-number-collision retry loops in the orders routes had been checking
 * `err.code` directly since Phase 3/4 — which meant a real collision would
 * never actually trigger a retry, it would just rethrow. In practice this
 * stayed invisible: order numbers use a random 4-hex suffix, so an actual
 * collision is rare enough it may never have fired. Centralized here so
 * every retry-on-collision loop checks both shapes correctly, and so this
 * doesn't quietly regress again if drizzle's wrapping ever changes.
 */
export function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const direct = (err as { code?: unknown }).code;
  if (direct === "23505") return true;
  const cause = (err as { cause?: { code?: unknown } }).cause;
  return Boolean(cause && typeof cause === "object" && cause.code === "23505");
}
