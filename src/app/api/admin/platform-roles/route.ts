import { NextResponse } from "next/server";
import { and, desc, eq, isNull, inArray } from "drizzle-orm";
import { db } from "@/db";
import { userRoles, users } from "@/db/schema";
import { requirePlatformPermission } from "@/lib/rbac/guard";
import { PLATFORM_PERMISSIONS, PLATFORM_ROLES } from "@/lib/rbac/platform-permissions";
import { parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { grantPlatformRoleSchema } from "@/lib/validation/platform-roles";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Platform Control Center (Phase 1) — the real grant/revoke path for
 * platform roles that didn't exist before this phase (previously only raw
 * SQL could create a platform_admin row, with zero accountability trail).
 * Every grant and revoke here is audited (see recordAuditLog calls below)
 * with restaurantId: null — a genuinely platform-level event, not tied to
 * any one tenant.
 */
export async function GET() {
  try {
    await requirePlatformPermission(PLATFORM_PERMISSIONS.MANAGE_PLATFORM_ADMINS);

    const rows = await db
      .select({
        id: userRoles.id,
        role: userRoles.role,
        isActive: userRoles.isActive,
        createdAt: userRoles.createdAt,
        userId: users.id,
        fullName: users.fullName,
        phone: users.phone,
        mfaEnabled: users.mfaEnabled,
      })
      .from(userRoles)
      .innerJoin(users, eq(userRoles.userId, users.id))
      .where(and(isNull(userRoles.restaurantId), inArray(userRoles.role, [...PLATFORM_ROLES])))
      .orderBy(desc(userRoles.createdAt));

    return NextResponse.json({ grants: rows });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const session = await requirePlatformPermission(PLATFORM_PERMISSIONS.MANAGE_PLATFORM_ADMINS);

    const parsed = await parseJsonBody(request, grantPlatformRoleSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const [targetUser] = await db
      .select({ id: users.id, fullName: users.fullName, phone: users.phone })
      .from(users)
      .where(eq(users.phone, data.phone))
      .limit(1);

    if (!targetUser) {
      return NextResponse.json(
        { error: "No account exists with that phone number. They must sign up first." },
        { status: 404 },
      );
    }

    const existingGrant = await db
      .select({ id: userRoles.id })
      .from(userRoles)
      .where(
        and(
          eq(userRoles.userId, targetUser.id),
          isNull(userRoles.restaurantId),
          eq(userRoles.role, data.role),
          eq(userRoles.isActive, true),
        ),
      )
      .limit(1);
    if (existingGrant.length > 0) {
      return NextResponse.json(
        { error: "This person already holds that platform role." },
        { status: 409 },
      );
    }

    const [grant] = await db
      .insert(userRoles)
      .values({
        userId: targetUser.id,
        restaurantId: null,
        branchId: null,
        role: data.role,
        invitedBy: session.user.id,
      })
      .returning();

    await recordAuditLog({
      restaurantId: null,
      userId: session.user.id,
      action: "platform_role.granted",
      resourceType: "user_role",
      resourceId: grant.id,
      ipAddress: getClientIp(request),
      metadata: {
        targetUserId: targetUser.id,
        targetPhone: targetUser.phone,
        role: data.role,
        reason: data.reason,
      },
    });

    return NextResponse.json(
      {
        grant: {
          id: grant.id,
          role: grant.role,
          isActive: grant.isActive,
          createdAt: grant.createdAt,
          userId: targetUser.id,
          fullName: targetUser.fullName,
          phone: targetUser.phone,
        },
      },
      { status: 201 },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
