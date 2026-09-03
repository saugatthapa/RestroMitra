import "server-only";
import { eq, and, inArray, desc, isNull } from "drizzle-orm";
import { db } from "@/db";
import { userRoles, rolePermissions, restaurants, branches, users } from "@/db/schema";
import { getSession, type SessionContext } from "@/lib/auth/session";
import { getImpersonationContext } from "@/lib/auth/impersonation";
import { HttpError } from "@/lib/http-error";
import { reconcileSubscriptionStatus } from "@/lib/subscription-db";
import type { AccessReason } from "@/lib/subscription";
import { isReadOnlyPermission, type PermissionKey } from "./permissions";
import { roleHasPlatformPermission, type PlatformPermissionKey } from "./platform-permissions";
import { getMaintenanceMode } from "@/lib/system/maintenance-mode-db";

/**
 * Platform Control Center (Phase 8) — true for platform_admin (the
 * pre-existing blanket cross-tenant bypass) OR either impersonation-
 * sourced role. Every place that already special-cases "platform_admin
 * bypasses this check" (suspension, subscription-active gating) should
 * bypass the same way for an active impersonation grant — the entire
 * point of impersonation is support/ops investigation, which is exactly
 * the same justification those bypasses already document for
 * platform_admin itself. Kept as one shared predicate so the two
 * call sites (resolveRestaurantContext, the dashboard layout) can't
 * silently drift out of sync with each other.
 */
export function isPlatformOrImpersonatedRole(role: string): boolean {
  return role === "platform_admin" || role === "impersonated_read" || role === "impersonated_write";
}

export class AuthError extends HttpError {
  constructor(message: string, status = 401) {
    super(message, status);
  }
}

/**
 * Thrown when a restaurant's subscription doesn't currently allow access
 * (trial expired, cancelled, ...) — a distinct class from AuthError (which
 * means "you're not who you say you are" or "you lack a permission") so
 * callers like the dashboard layout can catch this specific case and
 * redirect to /billing rather than treating it as a generic auth failure.
 * 402 Payment Required is the closest standard HTTP status for "this
 * would work, but the account isn't in a billable-access state."
 */
export class SubscriptionRequiredError extends HttpError {
  reason: AccessReason;
  constructor(reason: AccessReason, message: string) {
    super(message, 402);
    this.reason = reason;
  }
}

/**
 * Resolves the caller's authenticated identity. Throws (never returns a
 * "guest" object silently) so route handlers fail closed by default.
 */
export async function requireAuth(): Promise<SessionContext> {
  const session = await getSession();
  if (!session) throw new AuthError("Not authenticated", 401);
  return session;
}

/**
 * True for either of the two full-access platform-role tiers
 * (platform_admin, super_admin — see platform-permissions.ts's own doc
 * comment on why there are two). Kept as a boolean, role-only check — no
 * MFA condition here — because this function is also used as a pure role
 * predicate in places that must stay MFA-agnostic (e.g. isPlatformAdmin()
 * itself being asserted true/false in tests regardless of MFA state).
 * MFA enforcement for platform access is layered on top by each of this
 * function's three call sites that actually grant access from it:
 * requirePlatformAdmin(), requirePlatformPermission() (the platform
 * console's own gates), and requireRestaurantAccess()'s platform_admin
 * bypass below (security hardening — see that call site's own comment;
 * this used to be the one place platform access was granted with no MFA
 * check at all).
 */
export async function isPlatformAdmin(userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: userRoles.id })
    .from(userRoles)
    .where(
      and(
        eq(userRoles.userId, userId),
        inArray(userRoles.role, ["platform_admin", "super_admin"]),
        eq(userRoles.isActive, true),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Every ACTIVE platform-scoped role grant (restaurantId IS NULL) this user
 * holds — a user can hold more than one concurrently (see schema.ts's
 * user_roles_one_active_per_restaurant_unique index, which deliberately
 * excludes restaurantId IS NULL rows), e.g. someone might be both
 * billing_admin and support_admin. Returns role strings, not booleans, so
 * callers can check them against roleHasPlatformPermission for a specific
 * permission.
 */
export async function getActivePlatformRoles(userId: string): Promise<string[]> {
  const rows = await db
    .select({ role: userRoles.role })
    .from(userRoles)
    .where(
      and(
        eq(userRoles.userId, userId),
        isNull(userRoles.restaurantId),
        eq(userRoles.isActive, true),
      ),
    );
  return rows.map((r) => r.role);
}

/**
 * Platform Control Center (Phase 1) — every platform role requires MFA to
 * actually be enabled, not just requested. The blast radius of any
 * platform role (even the narrowest, platform_viewer, can read every
 * tenant's data) is high enough that this is enforced at the point of
 * access rather than left as a setting someone might not have turned on.
 * Throws a distinct, actionable message rather than a generic 403 so the
 * platform layout/routes can surface "go enable MFA" rather than a bare
 * "access denied".
 */
async function requirePlatformMfaEnabled(userId: string): Promise<void> {
  const [row] = await db
    .select({ mfaEnabled: users.mfaEnabled })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row?.mfaEnabled) {
    throw new AuthError(
      "MFA is required for platform access. Enable multi-factor authentication in your account settings, then retry.",
      403,
    );
  }
}

/**
 * Gap audit (P1) — "MFA is not enforced for restaurant owners, only for
 * platform admins... it's just not mandatory for the role (owner) that
 * controls a restaurant's financial data." Mirrors requirePlatformMfaEnabled's
 * pattern (fail closed with an actionable message at the point of a
 * sensitive action, not a blanket block that would create a redirect loop
 * for an owner who hasn't enrolled yet — see dashboard/layout.tsx's own
 * comment for the non-blocking banner half of this).
 *
 * Deliberately scoped by ROLE, not by permission: a no-op for any role
 * other than "owner", including a manager/accountant who happens to hold
 * the exact same permission (MANAGE_PAYROLL, REFUND_ORDER, ...) on a route
 * that also calls this. That is intentional — this protects the OWNER's
 * own use of these actions specifically (the audit's framing: MFA for
 * "the role that controls a restaurant's financial data"), never a
 * co-worker who happens to share the underlying permission. platform_admin
 * and the impersonation roles are likewise untouched here: their own MFA
 * requirement is already enforced one layer up, at the point platform
 * access itself was granted (requirePlatformAdmin/requirePlatformPermission),
 * before an impersonation session can even start.
 *
 * Callers: pass `requireOwnerMfa: true` to resolveRestaurantContext for a
 * specific money-moving route (refunds, payroll payments/void/payslips,
 * subscription/billing changes, staff role changes, financial-data
 * exports) rather than calling this directly — see that function's own
 * doc comment for why it runs after the permission check.
 */
export async function requireOwnerMfaEnabled(userId: string, role: string): Promise<void> {
  if (role !== "owner") return;
  const [row] = await db
    .select({ mfaEnabled: users.mfaEnabled })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row?.mfaEnabled) {
    throw new AuthError(
      "MFA is required for this action. Enable multi-factor authentication in your account settings (/dashboard/account), then retry.",
      403,
    );
  }
}

/**
 * Gap audit (P1) — pure predicate behind dashboard/layout.tsx's
 * non-blocking owner-MFA warning banner (the mirror of admin/layout.tsx's
 * own banner condition for platform roles). Factored out as a plain
 * function, rather than inlined in the layout, so it's unit-testable
 * without a component-rendering harness — this project has none (see
 * platform-authorization.test.ts's own comment on the same limitation for
 * requirePlatformAdmin's session-dependent half).
 *
 * Scoped to match requireOwnerMfaEnabled exactly: true only for the real
 * "owner" role, never during an impersonation session (which already
 * renders its own, separate banner) — a platform_admin/impersonated_read/
 * impersonated_write viewer is never shown this, since none of those is
 * this account's own ownership.
 */
export function shouldShowOwnerMfaWarning(params: {
  isImpersonating: boolean;
  role: string;
  mfaEnabled: boolean;
}): boolean {
  return !params.isImpersonating && params.role === "owner" && !params.mfaEnabled;
}

/**
 * Fails closed for any endpoint that operates across every tenant (the
 * platform admin console) rather than within one restaurant's scope —
 * distinct from requireRestaurantAccess, which is about access to ONE
 * restaurant. Every route under /api/admin/ must call this before doing
 * anything. Also enforces the platform-wide MFA requirement (see
 * requirePlatformMfaEnabled) — unlike isPlatformAdmin(), which stays a pure
 * role check for use inside requireRestaurantAccess.
 */
export async function requirePlatformAdmin(): Promise<SessionContext> {
  const session = await requireAuth();
  const admin = await isPlatformAdmin(session.user.id);
  if (!admin) {
    throw new AuthError("Platform admin access required.", 403);
  }
  await requirePlatformMfaEnabled(session.user.id);
  return session;
}

/**
 * Fine-grained platform authorization: succeeds if the caller holds ANY
 * active platform role that grants `permission` (see
 * roleHasPlatformPermission), after confirming MFA is enabled. This is the
 * primitive every new Platform Control Center route (tenant management,
 * subscriptions, entitlements, AI provider config, impersonation, support
 * tooling, ...) should call — requirePlatformAdmin() remains for routes
 * that intentionally require full access regardless of the finer catalog
 * (there are very few of these; prefer this function for anything new).
 */
export async function requirePlatformPermission(
  permission: PlatformPermissionKey,
): Promise<SessionContext> {
  const session = await requireAuth();
  await requirePlatformMfaEnabled(session.user.id);

  const roles = await getActivePlatformRoles(session.user.id);
  const allowed = roles.some((role) => roleHasPlatformPermission(role, permission));
  if (!allowed) {
    throw new AuthError(`Missing platform permission: ${permission}`, 403);
  }
  return session;
}

/**
 * Phase 10's billing gate: throws SubscriptionRequiredError when a
 * restaurant's subscription doesn't currently allow access (trial
 * expired, cancelled). Reads (and, exactly once per expiry, writes) via
 * reconcileSubscriptionStatus so `restaurants.subscription_status` never
 * silently drifts from what access decisions actually use.
 *
 * Deliberately NOT folded into requireRestaurantAccess() itself — that
 * function answers "does this user have a role at this restaurant," a
 * question platform-admin support tooling and the billing page itself
 * both still need answered even when the subscription is inactive. This
 * is a separate, skippable check layered on top by resolveRestaurantContext().
 */
export async function requireActiveSubscription(restaurantId: string): Promise<void> {
  const access = await reconcileSubscriptionStatus(restaurantId);
  if (!access.allowed) {
    throw new SubscriptionRequiredError(
      access.reason,
      "This restaurant's subscription is not active.",
    );
  }
}

/**
 * Platform Control Center (Phase 2) — thrown when a restaurant has been
 * suspended by a platform admin. Deliberately a distinct error class from
 * SubscriptionRequiredError: suspension is a platform-ops decision
 * (abuse/fraud investigation, policy violation, ...) orthogonal to
 * billing state — a restaurant can be suspended while its subscription is
 * perfectly current, and reactivating it is never a self-service billing
 * action the owner can take from /billing.
 */
export class TenantSuspendedError extends HttpError {
  constructor(message = "This restaurant's access has been suspended.") {
    super(message, 403);
  }
}

/**
 * Platform Control Center (Phase 2) — restaurants.isActive already existed
 * in the schema (defaulting true) and already gated the public-facing QR
 * ordering/website surfaces, but nothing ever set it to false and no
 * staff-facing route checked it: a "suspended" restaurant's own staff
 * could log into /dashboard exactly as normal. This closes that gap, using
 * the same column rather than adding a new one — see the suspension route
 * (src/app/api/admin/restaurants/[restaurantId]/suspension) for the only
 * place that flips it.
 */
export async function requireRestaurantActive(restaurantId: string): Promise<void> {
  const [row] = await db
    .select({ isActive: restaurants.isActive })
    .from(restaurants)
    .where(eq(restaurants.id, restaurantId))
    .limit(1);
  if (row && !row.isActive) {
    throw new TenantSuspendedError();
  }
}

/**
 * No payment gateway is integrated yet, so a self-serve signup can't be
 * confirmed as a real, paying restaurant the way a checkout would confirm
 * it — see restaurants.verifiedAt's own schema comment. Distinct error
 * class from TenantSuspendedError: this isn't a policy/abuse decision, it's
 * "we haven't manually confirmed you yet," and the dashboard layout routes
 * it to a different page (/verify-account, not /suspended) with different
 * messaging and no admin "reason" required to resolve it.
 */
export class RestaurantNotVerifiedError extends HttpError {
  constructor(message = "This restaurant hasn't been verified yet.") {
    super(message, 403);
  }
}

/**
 * Mirrors requireRestaurantActive exactly, one column over. Checked right
 * after it in resolveRestaurantContext (and in the dashboard layout, same
 * ordering) — suspension is the more deliberate, ops-driven block, so a
 * restaurant that's somehow both unverified and suspended lands on
 * /suspended, not /verify-account.
 */
export async function requireRestaurantVerified(restaurantId: string): Promise<void> {
  const [row] = await db
    .select({ verifiedAt: restaurants.verifiedAt })
    .from(restaurants)
    .where(eq(restaurants.id, restaurantId))
    .limit(1);
  if (row && !row.verifiedAt) {
    throw new RestaurantNotVerifiedError();
  }
}

/**
 * Platform Control Center (Phase 10) — thrown when platform-wide
 * maintenance mode is on and the caller isn't a platform admin or an
 * active impersonation session. Deliberately its own error class/status
 * (503, "temporarily unavailable" — not a permission problem, a
 * scheduled-downtime one) rather than reusing TenantSuspendedError, which
 * means something ops-decided about ONE tenant specifically.
 */
export class MaintenanceModeActiveError extends HttpError {
  constructor(message = "The platform is temporarily down for maintenance.") {
    super(message, 503);
  }
}

/**
 * Platform Control Center (Phase 10) — the maintenance-mode gate.
 * Deliberately takes the already-resolved `role` (same pattern as
 * requireActiveSubscription's caller in resolveRestaurantContext) rather
 * than re-deriving it, and skips the check entirely for
 * platform_admin/impersonated roles — see isPlatformOrImpersonatedRole's
 * own comment: that exemption IS this phase's "break-glass access," and
 * every audit_logs entry recorded while maintenance is active is
 * separately auto-tagged `duringMaintenanceMode: true` (see audit.ts) for
 * traceability of what was done under it.
 */
export async function requireNotInMaintenanceMode(role: string): Promise<void> {
  if (isPlatformOrImpersonatedRole(role)) return;
  const state = await getMaintenanceMode();
  if (state.enabled) {
    throw new MaintenanceModeActiveError(
      state.message ?? "The platform is temporarily down for maintenance.",
    );
  }
}

/**
 * The core tenant-isolation choke point.
 *
 * `restaurantId` here MUST come from a trusted server-side source — a URL
 * path segment resolved against the DB, or the session's active restaurant
 * — and is then verified against this user's actual role grants. A caller
 * can never simply assert "I am restaurant X" without a matching, active
 * user_roles row; there is no other code path that grants tenant access.
 *
 * Returns the role grant (and branch scope, if any) so callers can make
 * branch-level decisions too.
 */
export async function requireRestaurantAccess(
  userId: string,
  restaurantId: string,
): Promise<{ role: string; branchId: string | null }> {
  // Platform Control Center (Phase 8) — an ACTIVE impersonation session
  // scoped to EXACTLY this restaurant takes precedence over everything
  // below, including the platform_admin blanket bypass a few lines down.
  // This is deliberate: once an admin has gone through the reasoned,
  // audited, bannered impersonation flow, its own mode (read-only vs
  // write) is what should actually govern what they can do here — a
  // platform_admin/super_admin's separate always-on bypass must never
  // silently make the impersonation banner's "read-only" promise
  // meaningless. Scoped to targetRestaurantId only (never "any
  // restaurant"), and to this exact adminUserId — see
  // ImpersonationContext's own doc comment for why this never re-derives
  // identity, only adds a capability grant on top of it.
  const impersonation = await getImpersonationContext();
  if (
    impersonation &&
    impersonation.adminUserId === userId &&
    impersonation.targetRestaurantId === restaurantId
  ) {
    return {
      role: impersonation.mode === "write" ? "impersonated_write" : "impersonated_read",
      branchId: null,
    };
  }

  const admin = await isPlatformAdmin(userId);
  if (admin) {
    // Security hardening — this bypass used to grant blanket cross-tenant
    // access with NO MFA check at all, unlike every other platform-access
    // entry point (requirePlatformAdmin/requirePlatformPermission both
    // call requirePlatformMfaEnabled before returning). That was a real
    // boundary gap: a platform_admin who had never enabled MFA could
    // reach money-moving tenant-scoped routes (refunds, payroll,
    // subscription/billing changes, financial exports — anything gated
    // via resolveRestaurantContext's `requireOwnerMfa` option, which is a
    // no-op for this role specifically because it assumes "MFA was
    // already enforced one layer up") directly, with no impersonation
    // step and therefore no impersonation audit trail either. Was
    // previously documented as "no MFA condition here" (see
    // isPlatformAdmin's own comment) and deliberately deferred — see
    // PLATFORM_CONTROL_CENTER_IMPLEMENTATION_REPORT.md's "hardening
    // candidate" note — because isPlatformAdmin() itself is also used as
    // a pure role predicate elsewhere and must stay MFA-agnostic; the fix
    // belongs here, at the one call site that actually grants tenant
    // access from it, not inside isPlatformAdmin() itself.
    await requirePlatformMfaEnabled(userId);
    // Platform admins can act across tenants for support/ops purposes,
    // but every such action must still be written to audit_logs by the
    // caller — this function only establishes *access*, not exemption
    // from logging.
    return { role: "platform_admin", branchId: null };
  }

  // .limit(1) here relies on a real invariant, not luck: at most one
  // ACTIVE user_roles row can ever exist for a given (userId,
  // restaurantId) — enforced both where a grant is created (the staff
  // POST route's existingGrant check) and where one is reactivated (the
  // staff PATCH route's matching check), and backstopped at the DB level
  // by user_roles_one_active_per_restaurant_unique (see schema.ts). The
  // ORDER BY is cheap extra insurance, not the load-bearing guarantee: if
  // that invariant were ever violated some other way (a manual DB edit, a
  // future code path that forgets the check), this at least resolves
  // deterministically to the most recently granted role instead of
  // whatever order Postgres happens to return, rather than silently
  // depending on row-storage order.
  const rows = await db
    .select({ role: userRoles.role, branchId: userRoles.branchId })
    .from(userRoles)
    .where(
      and(
        eq(userRoles.userId, userId),
        eq(userRoles.restaurantId, restaurantId),
        eq(userRoles.isActive, true),
      ),
    )
    .orderBy(desc(userRoles.createdAt))
    .limit(1);

  const grant = rows[0];
  if (!grant) {
    throw new AuthError(
      "You do not have access to this restaurant.",
      403,
    );
  }
  return grant;
}

/**
 * `knownRole` — perf: pass the role when the caller already resolved it in
 * this same request (almost always via resolveRestaurantContext just
 * before this call) to skip re-deriving it from scratch (isPlatformAdmin +
 * a userRoles select). Every existing call site that omits it keeps
 * behaving exactly as before — this is purely additive. See
 * PERFORMANCE_AUDIT.md's §3 finding: this exact re-derivation, repeated 2-3x
 * per request across nearly every route, was one of the most repeated
 * avoidable costs in the app.
 */
export async function requirePermission(
  userId: string,
  restaurantId: string,
  permission: PermissionKey,
  knownRole?: string,
): Promise<void> {
  const role = knownRole ?? (await requireRestaurantAccess(userId, restaurantId)).role;

  if (role === "platform_admin" || role === "owner" || role === "impersonated_write") return;

  // Platform Control Center (Phase 8) — a read-only impersonation session
  // is never a bypass: it's granted exactly the view_* permissions
  // (isReadOnlyPermission), nothing else, checked here rather than
  // falling through to the rolePermissions table lookup below (that table
  // only knows about the real staff-role enum — "impersonated_read" isn't
  // a value in it, and was never meant to be).
  if (role === "impersonated_read") {
    if (isReadOnlyPermission(permission)) return;
    throw new AuthError(
      `Missing permission: ${permission} (read-only impersonation session)`,
      403,
    );
  }

  const rows = await db
    .select({ permissionKey: rolePermissions.permissionKey })
    .from(rolePermissions)
    .where(
      and(
        eq(rolePermissions.role, role as (typeof rolePermissions.role.enumValues)[number]),
        eq(rolePermissions.permissionKey, permission),
      ),
    )
    .limit(1);

  if (rows.length === 0) {
    throw new AuthError(
      `Missing permission: ${permission}`,
      403,
    );
  }
}

/**
 * Like requirePermission, but succeeds if the caller holds ANY ONE of the
 * given permissions — for actions more than one role is legitimately
 * allowed to take (e.g. advancing an order through its kitchen stages is
 * fine via either EDIT_ORDER, held by waiter/cashier/manager/owner, or the
 * narrower UPDATE_KDS_STATUS, held by kitchen_staff). Still fails closed:
 * an empty permissions list is always denied, never trivially satisfied.
 */
/** `knownRole` — see requirePermission's doc comment; same perf rationale. */
export async function requireAnyPermission(
  userId: string,
  restaurantId: string,
  permissions: PermissionKey[],
  knownRole?: string,
): Promise<void> {
  if (permissions.length === 0) {
    throw new AuthError("No permission would satisfy this action.", 403);
  }

  const role = knownRole ?? (await requireRestaurantAccess(userId, restaurantId)).role;

  if (role === "platform_admin" || role === "owner" || role === "impersonated_write") return;

  // See requirePermission's matching comment — read-only impersonation
  // gets exactly the view_* permissions among the ones offered, never a
  // rolePermissions table lookup for a role string that isn't a real one.
  if (role === "impersonated_read") {
    if (permissions.some((p) => isReadOnlyPermission(p))) return;
    throw new AuthError(
      `Missing permission: one of [${permissions.join(", ")}] (read-only impersonation session)`,
      403,
    );
  }

  const rows = await db
    .select({ permissionKey: rolePermissions.permissionKey })
    .from(rolePermissions)
    .where(
      and(
        eq(rolePermissions.role, role as (typeof rolePermissions.role.enumValues)[number]),
        inArray(rolePermissions.permissionKey, permissions),
      ),
    )
    .limit(1);

  if (rows.length === 0) {
    throw new AuthError(
      `Missing permission: one of [${permissions.join(", ")}]`,
      403,
    );
  }
}

/**
 * Non-throwing permission check — for cases where a route needs to make a
 * decision based on whether the caller holds a permission (e.g. including
 * cost/margin fields in a response only for someone with VIEW_PROFIT)
 * rather than rejecting the whole request when they don't have it.
 * requirePermission()/requireAnyPermission() remain the right choice
 * whenever the answer is "reject the request" rather than "adjust what
 * comes back".
 */
/** `knownRole` — see requirePermission's doc comment; same perf rationale. */
export async function hasPermission(
  userId: string,
  restaurantId: string,
  permission: PermissionKey,
  knownRole?: string,
): Promise<boolean> {
  try {
    await requirePermission(userId, restaurantId, permission, knownRole);
    return true;
  } catch (err) {
    if (err instanceof AuthError) return false;
    throw err;
  }
}

/**
 * Resolves a restaurant by slug and confirms the given user has access to
 * it. Use this instead of trusting a restaurant_id posted from the client.
 *
 * Also returns `timezone` — free, since this already SELECTs the
 * restaurant row to resolve the slug — so every route going through
 * resolveRestaurantContext() gets it for "what day is it for this
 * restaurant" computations (see src/lib/restaurant-date.ts) without a
 * second query.
 */
export async function requireRestaurantBySlug(
  userId: string,
  slug: string,
): Promise<{ restaurantId: string; role: string; branchId: string | null; timezone: string }> {
  const rows = await db
    .select({ id: restaurants.id, timezone: restaurants.timezone })
    .from(restaurants)
    .where(eq(restaurants.slug, slug))
    .limit(1);

  const restaurant = rows[0];
  if (!restaurant) throw new AuthError("Restaurant not found", 404);

  const grant = await requireRestaurantAccess(userId, restaurant.id);
  return { restaurantId: restaurant.id, timezone: restaurant.timezone, ...grant };
}

/**
 * `knownGrant` — perf: pass `{ role, branchId }` when the caller already
 * resolved it this request (typically resolveRestaurantContext's return
 * value) to skip re-deriving it from scratch. See requirePermission's doc
 * comment for the same rationale; omitting this behaves exactly as before.
 */
export async function requireBranchAccess(
  userId: string,
  restaurantId: string,
  branchId: string,
  knownGrant?: { role: string; branchId: string | null },
): Promise<void> {
  const { role, branchId: grantedBranchId } =
    knownGrant ?? (await requireRestaurantAccess(userId, restaurantId));
  void role;

  // P0-1 fix: this check used to run only for a branch-SCOPED grant
  // (after already confirming grantedBranchId === branchId, so it was
  // largely redundant there) and was skipped entirely for an unrestricted
  // (grantedBranchId === null) grant via an early return above. That meant
  // this function's own name promised "does this user have access to
  // THIS branch of THIS restaurant" but an unrestricted caller never
  // actually got the second half verified — a caller passing a branchId
  // that belongs to a DIFFERENT restaurant (or doesn't exist at all)
  // would sail through as long as the user had any unrestricted grant on
  // `restaurantId`. Every real call site in this app independently
  // re-applies eq(table.restaurantId, trustedRestaurantId) on its own
  // queries (defense in depth), so this was never actually exploitable in
  // practice — but a primitive named "requireBranchAccess" should itself
  // guarantee what it claims to, for whatever calls it next. Running this
  // unconditionally, before considering the grant, closes that gap.
  const rows = await db
    .select({ id: branches.id })
    .from(branches)
    .where(and(eq(branches.id, branchId), eq(branches.restaurantId, restaurantId)))
    .limit(1);
  if (rows.length === 0) throw new AuthError("Branch not found", 404);

  // Owners/managers/platform admins with a NULL branchId on their grant
  // have access to every branch of the restaurant — now confirmed above to
  // actually belong to it. Staff scoped to a specific branch can only act
  // on that one branch.
  if (grantedBranchId === null) return;
  if (grantedBranchId !== branchId) {
    throw new AuthError("You do not have access to this branch.", 403);
  }
}

/**
 * Same idea as requireBranchAccess, for an action that legitimately
 * concerns TWO branches (Commercial Launch Phase A.7 — Stock Transfer:
 * requesting/approving/cancelling a transfer is something either the
 * sending or the receiving branch's staff should be able to do). Passes if
 * the caller has access to at least one of the two branches; an
 * unrestricted grant (branchId === null) still needs both branches to
 * actually belong to this restaurant, same defense-in-depth as
 * requireBranchAccess itself. Throws the same 403/404 shape as
 * requireBranchAccess when neither branch is reachable.
 */
export async function requireEitherBranchAccess(
  userId: string,
  restaurantId: string,
  branchIdA: string,
  branchIdB: string,
  knownGrant?: { role: string; branchId: string | null },
): Promise<void> {
  const grant = knownGrant ?? (await requireRestaurantAccess(userId, restaurantId));
  if (grant.branchId === null) {
    // Unrestricted — still confirm both branches are real, belonging to
    // this restaurant (requireBranchAccess's own 404 check).
    await requireBranchAccess(userId, restaurantId, branchIdA, grant);
    await requireBranchAccess(userId, restaurantId, branchIdB, grant);
    return;
  }
  if (grant.branchId === branchIdA || grant.branchId === branchIdB) {
    await requireBranchAccess(userId, restaurantId, grant.branchId, grant);
    return;
  }
  throw new AuthError("You do not have access to either branch for this transfer.", 403);
}

/**
 * QA hardening pass (branch-isolation audit) — like requireBranchAccess, but
 * for a resource whose OWN branchId can itself be NULL: a staff/payroll
 * grant with `branchId: null` means "unrestricted, all branches" (see
 * ASSIGNABLE_STAFF_ROLES in validation/staff.ts — any assignable role, not
 * just owner/manager, can be granted this). requireBranchAccess can't be
 * called directly for that case (it requires a concrete branchId to check
 * against), and skipping the check entirely would let a branch-scoped
 * manager holding MANAGE_STAFF/MANAGE_PAYROLL reach into another branch's
 * staff, or into a restaurant-wide grant that isn't "theirs" at all.
 *
 * Rule: a target scoped to a real branch is checked exactly like
 * requireBranchAccess (unrestricted callers pass, branch-scoped callers
 * need an exact match). A target that is itself unrestricted (branchId:
 * null) may only be acted on by an unrestricted caller — a branch-scoped
 * caller has no legitimate branch to claim it under, so this fails closed
 * rather than silently allowing it.
 */
export async function requireBranchAccessForNullableTarget(
  userId: string,
  restaurantId: string,
  targetBranchId: string | null,
  knownGrant?: { role: string; branchId: string | null },
): Promise<void> {
  if (targetBranchId !== null) {
    await requireBranchAccess(userId, restaurantId, targetBranchId, knownGrant);
    return;
  }
  const { branchId: grantedBranchId } =
    knownGrant ?? (await requireRestaurantAccess(userId, restaurantId));
  if (grantedBranchId !== null) {
    throw new AuthError("You do not have access to this branch.", 403);
  }
}
