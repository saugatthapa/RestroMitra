import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { userRoles, users } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { resetStaffPasswordSchema } from "@/lib/validation/staff";
import { hashPassword, validatePasswordStrength } from "@/lib/auth/password";
import { destroyAllSessions } from "@/lib/auth/session";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { requireBranchAccessForNullableTarget } from "@/lib/rbac/guard";

async function getOwnedGrant(restaurantId: string, userRoleId: string) {
  const rows = await db
    .select()
    .from(userRoles)
    .where(and(eq(userRoles.id, userRoleId), eq(userRoles.restaurantId, restaurantId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Commercial Launch Phase B.3 — admin-assisted password reset. This app
 * has no working self-service delivery channel for a staff member with no
 * email on file (see forgot-password/route.ts's own doc comment on why),
 * so the realistic recovery path for those accounts is an owner/manager
 * who already holds MANAGE_STAFF setting a fresh password directly — the
 * exact same trust level AddStaffForm already uses to set the INITIAL
 * password when creating an account (see staff/route.ts), just extended
 * to an existing one.
 *
 * Same guardrails as the sibling PATCH route on this staff member:
 *  - never for an "owner"/"platform_admin" grant — those aren't managed
 *    through this staff-admin surface at all.
 *  - never for the CALLER'S OWN account — an admin resetting their own
 *    password this way would bypass change-password's "prove you still
 *    know the current password" check entirely; they must use that
 *    self-service flow (or forgot-password) for themselves instead.
 *
 * On success, every session for that account is destroyed (matching
 * change-password/reset-password's own "a new password invalidates
 * whatever session might already be compromised" reasoning) — the staff
 * member logs in fresh with the new password the admin just told them.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string; userRoleId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, userRoleId } = await ctx.params;
    const { session, restaurantId, role, branchId: grantedBranchId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_STAFF,
    );

    const existing = await getOwnedGrant(restaurantId, userRoleId);
    if (!existing) {
      return NextResponse.json({ error: "Staff member not found." }, { status: 404 });
    }
    // QA hardening pass — a branch-scoped manager holding MANAGE_STAFF must
    // not be able to reset a DIFFERENT branch's (or a restaurant-wide)
    // staff member's password. See requireBranchAccessForNullableTarget's
    // own doc comment for why a null target branchId needs special handling.
    await requireBranchAccessForNullableTarget(session.user.id, restaurantId, existing.branchId, {
      role,
      branchId: grantedBranchId,
    });
    if (existing.role === "owner" || existing.role === "platform_admin") {
      return NextResponse.json(
        { error: "The restaurant owner's password can't be reset here." },
        { status: 400 },
      );
    }
    if (existing.userId === session.user.id) {
      return NextResponse.json(
        { error: "Use \"Change password\" on your own account instead." },
        { status: 400 },
      );
    }

    const parsed = await parseJsonBody(request, resetStaffPasswordSchema);
    if (!parsed.ok) return parsed.response;

    const strengthError = validatePasswordStrength(parsed.data.newPassword);
    if (strengthError) {
      return NextResponse.json({ error: strengthError }, { status: 400 });
    }

    const newHash = await hashPassword(parsed.data.newPassword);
    await db.update(users).set({ passwordHash: newHash }).where(eq(users.id, existing.userId));

    const revokedCount = await destroyAllSessions(existing.userId);

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "staff.password_reset",
      resourceType: "user_role",
      resourceId: userRoleId,
      ipAddress: getClientIp(request),
      metadata: { staffUserId: existing.userId, sessionsRevoked: revokedCount },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
