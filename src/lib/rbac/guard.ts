import "server-only";
import { eq, and, inArray } from "drizzle-orm";
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

export async function requirePermission(
  userId: string,
  restaurantId: string,
  permission: PermissionKey,
): Promise<void> {
  const { role } = await requireRestaurantAccess(userId, restaurantId);

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
export async function requireAnyPermission(
  userId: string,
  restaurantId: string,
  permissions: PermissionKey[],
): Promise<void> {
  if (permissions.length === 0) {
    throw new AuthError("No permission would satisfy this action.", 403);
  }

  const { role } = await requireRestaurantAccess(userId, restaurantId);

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
export async function hasPermission(
  userId: string,
  restaurantId: string,
  permission: PermissionKey,
): Promise<boolean> {
  try {
    await requirePermission(userId, restaurantId, permission);
    return true;
  } catch (err) {
    if (err instanceof AuthError) return false;
    throw err;
  }
}

/**
 * Resolves a restaurant by slug and confirms the given user has access to
 * it. Use this instead of trusting a restaurant_id posted from the client.
 */
export async function requireRestaurantBySlug(
  userId: string,
  slug: string,
): Promise<{ restaurantId: string; role: string; branchId: string | null }> {
  const rows = await db
    .select({ id: restaurants.id })
    .from(restaurants)
    .where(eq(restaurants.slug, slug))
    .limit(1);

  const restaurant = rows[0];
  if (!restaurant) throw new AuthError("Restaurant not found", 404);

  const grant = await requireRestaurantAccess(userId, restaurant.id);
  return { restaurantId: restaurant.id, ...grant };
}

export async function requireBranchAccess(
  userId: string,
  restaurantId: string,
  branchId: string,
): Promise<void> {
  const { role, branchId: grantedBranchId } = await requireRestaurantAccess(
    userId,
    restaurantId,
  );

  // Owners/managers/platform admins with a NULL branchId on their grant
  // have access to all branches of the restaurant. Staff scoped to a
  // specific branch can only act on that branch.
  if (grantedBranchId === null) return;
  if (grantedBranchId !== branchId) {
    throw new AuthError("You do not have access to this branch.", 403);
  }
  void role;

  const rows = await db
    .select({ id: branches.id })
    .from(branches)
    .where(and(eq(branches.id, branchId), eq(branches.restaurantId, restaurantId)))
    .limit(1);
  if (rows.length === 0) throw new AuthError("Branch not found", 404);
}
