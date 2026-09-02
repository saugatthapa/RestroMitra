/**
 * Platform Control Center (Phase 5) — the entitlement engine's pure
 * resolution logic. Deliberately dependency-free (no DB, no "server-only"),
 * same "pure counterpart to a *-db.ts module" pattern as plans.ts/
 * plans-db.ts — this is what makes the priority rule itself unit-testable
 * without a database, and safe to reuse from a client component (the
 * "explain this tenant's access" screen renders these results directly).
 *
 * Three independent inputs can grant or deny one feature key to one
 * restaurant; this function is the single place that decides which one
 * wins when more than one applies. See src/db/schema.ts's featureFlags/
 * entitlementOverrides table comments for what each input represents, and
 * src/lib/entitlements-db.ts for where the actual DB reads happen.
 */

export type EntitlementSource = "override" | "plan" | "flag" | "none";

export type EntitlementResult = {
  featureKey: string;
  granted: boolean;
  source: EntitlementSource;
  /**
   * The override's expiresAt, echoed back only when source is "override" —
   * absent for every other source. null means that override has no expiry
   * (permanent); a Date means it's still active as of `now` (see
   * EntitlementInputs.overrideExpiresAt for what happens once it isn't).
   */
  expiresAt?: Date | null;
};

export type EntitlementInputs = {
  /** This restaurant's effective plan's featureKeys (see getEffectivePlan in plans-db.ts). Empty array if no plan is assigned. */
  planFeatureKeys: string[];
  /**
   * This restaurant's entitlement_overrides row for this exact feature key,
   * if one exists — undefined/null means "no override," NOT "override to
   * false." A `granted: false` override is a real, deliberate revocation
   * and must be distinguished from "no row at all."
   */
  override?: boolean | null;
  /**
   * That same override row's expiresAt column, if one exists. undefined/
   * null means "no expiry" (a permanent override — the historical default,
   * before this column existed). A non-null value in the past makes
   * resolveFeatureAccess() treat `override` as if it weren't there at all,
   * falling through to plan/flag/none exactly as if the row had been
   * manually revoked — see resolveFeatureAccess's own comment for why this
   * is a plain comparison against `now` rather than a swept/deleted row.
   */
  overrideExpiresAt?: Date | null;
  /** The feature_flags row's defaultEnabled for this key, if one exists. undefined/null means "no flag defined for this key." */
  flagDefault?: boolean | null;
};

/**
 * Resolves whether `featureKey` is granted to a restaurant, and WHY —
 * every caller (a route gate, the admin "explain" screen) gets both the
 * boolean and its source, since "why does/doesn't this tenant have X" is
 * exactly the question a platform admin needs answered, not just the
 * yes/no.
 *
 * Priority, most specific wins:
 *  1. PLATFORM_OVERRIDE — an explicit per-tenant admin decision always
 *     wins, whether it grants a feature the plan wouldn't otherwise
 *     include or revokes one the plan would.
 *  2. PLAN — the restaurant's own plan already includes this key.
 *  3. FEATURE_FLAG — a global default for a key not covered by the plan
 *     (an experimental rollout, a kill switch).
 *  4. NONE — nothing grants it.
 *
 * `now` defaults to the real clock but is an explicit parameter — same
 * "pass now in, don't call Date.now() buried inside the function" shape as
 * isAnnouncementCurrentlyShowable (system/announcements.ts) — so an expired
 * override is exercisable in a unit test without mocking the system clock.
 *
 * Expiry is CHECKED HERE, NOT SWEPT: there is no background job that
 * deletes or flips a status on an entitlement_overrides row once its
 * expiresAt passes (see that column's comment in schema.ts) — the row just
 * stops being treated as active the moment `now` passes it, computed fresh
 * on every call. That keeps "is this override active" a pure function of
 * (row, now) with nothing to keep in sync, same "computed, not swept"
 * reasoning as isAnnouncementCurrentlyShowable's own startsAt/endsAt window
 * and coupons.ts's expiresAt check.
 */
export function resolveFeatureAccess(
  featureKey: string,
  inputs: EntitlementInputs,
  now: Date = new Date(),
): EntitlementResult {
  const overrideExpired =
    inputs.overrideExpiresAt !== undefined &&
    inputs.overrideExpiresAt !== null &&
    inputs.overrideExpiresAt.getTime() <= now.getTime();
  if (!overrideExpired && inputs.override !== undefined && inputs.override !== null) {
    return { featureKey, granted: inputs.override, source: "override", expiresAt: inputs.overrideExpiresAt };
  }
  if (inputs.planFeatureKeys.includes(featureKey)) {
    return { featureKey, granted: true, source: "plan" };
  }
  if (inputs.flagDefault !== undefined && inputs.flagDefault !== null) {
    return { featureKey, granted: inputs.flagDefault, source: "flag" };
  }
  return { featureKey, granted: false, source: "none" };
}
