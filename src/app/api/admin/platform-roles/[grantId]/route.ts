import { NextResponse } from "next/server";
import { and, count, eq, isNull, ne, inArray } from "drizzle-orm";
import { db } from "@/db";
import { userRoles, users } from "@/db/schema";
import { requirePlatformPermission } from "@/lib/rbac/guard";
import { PLATFORM_PERMISSIONS } from "@/lib/rbac/platform-permissions";
import { parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { revokePlatformRoleSchema } from "@/lib/validation/platform-roles";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

const FULL_ACCESS_ROLES = ["platform_admin", "super_admin"] as const;

/**
 * Revokes (deactivates, never deletes — same "history stays, isActive
 * flips off" convention as the tenant staff PATCH route) one platform role
 * grant. Refuses to revoke the platform's LAST remaining full-access grant
 * (platform_admin/super_admin) — without this check, a mistaken or
 * malicious revoke could lock every platform admin out permanently, with
 * no raw-SQL-free way back in.
 */
export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ grantId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const session = await requirePlatformPermission(PLATFORM_PERMISSIONS.MANAGE_PLATFORM_ADMINS);
    const { grantId } = await ctx.params;

    const parsed = await parseJsonBody(request, revokePlatformRoleSchema);
    if (!parsed.ok) return parsed.response;
    const { reason } = parsed.data;

    const [grant] = await db
      .select({
        id: userRoles.id,
        role: userRoles.role,
        isActive: userRoles.isActive,
        userId: userRoles.userId,
        restaurantId: userRoles.restaurantId,
      })
      .from(userRoles)
      .where(eq(userRoles.id, grantId))
      .limit(1);

    if (!grant || grant.restaurantId !== null) {
      return NextResponse.json({ error: "Platform role grant not found." }, { status: 404 });
    }
    if (!grant.isActive) {
      return NextResponse.json({ error: "This grant is already inactive." }, { status: 409 });
    }

    if ((FULL_ACCESS_ROLES as readonly string[]).includes(grant.role)) {
      const [remaining] = await db
        .select({ n: count() })
        .from(userRoles)
        .where(
          and(
            isNull(userRoles.restaurantId),
            inArray(userRoles.role, [...FULL_ACCESS_ROLES]),
            eq(userRoles.isActive, true),
            ne(userRoles.id, grantId),
          ),
        );
      if ((remaining?.n ?? 0) === 0) {
        return NextResponse.json(
          {
            error:
              "Cannot revoke the platform's last full-access admin. Grant another platform_admin or super_admin first.",
          },
          { status: 400 },
        );
      }
    }

    await db.update(userRoles).set({ isActive: false }).where(eq(userRoles.id, grantId));

    const [targetUser] = await db
      .select({ phone: users.phone })
      .from(users)
      .where(eq(users.id, grant.userId))
      .limit(1);

    await recordAuditLog({
      restaurantId: null,
      userId: session.user.id,
      action: "platform_role.revoked",
      resourceType: "user_role",
      resourceId: grant.id,
      ipAddress: getClientIp(request),
      metadata: {
        targetUserId: grant.userId,
        targetPhone: targetUser?.phone ?? null,
        role: grant.role,
        reason,
      },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
