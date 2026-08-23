import "server-only";
import { eq, and, inArray, desc } from "drizzle-orm";
import { db } from "@/db";
import { userRoles, rolePermissions, restaurants, branches } from "@/db/schema";
import { getSession, type SessionContext } from "@/lib/auth/session";
import { HttpError } from "@/lib/http-error";
import { reconcileSubscriptionStatus } from "@/lib/subscription-db";
import type { AccessReason } from "@/lib/subscription";
import type { PermissionKey } from "./permissions";

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

export async function isPlatformAdmin(userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: userRoles.id })
    .from(userRoles)
    .where(
      and(
        eq(userRoles.userId, userId),
        eq(userRoles.role, "platform_admin"),
        eq(userRoles.isActive, true),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Fails closed for any endpoint that operates across every tenant (the
 * platform admin console) rather than within one restaurant's scope —
 * distinct from requireRestaurantAccess, which is about access to ONE
 * restaurant. Every route under /api/admin/ must call this before doing
 * anything.
 */
export async function requirePlatformAdmin(): Promise<SessionContext> {
  const session = await requireAuth();
  const admin = await isPlatformAdmin(session.user.id);
  if (!admin) {
    throw new AuthError("Platform admin access required.", 403);
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
  const admin = await isPlatformAdmin(userId);
  if (admin) {
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

  if (role === "platform_admin" || role === "owner") return;

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

  if (role === "platform_admin" || role === "owner") return;

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
