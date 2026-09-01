import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { userRoles } from "@/db/schema";
import { requirePlatformPermission } from "@/lib/rbac/guard";
import { PLATFORM_PERMISSIONS } from "@/lib/rbac/platform-permissions";
import { toErrorResponse } from "@/lib/api-route-helpers";
import { destroySessionById } from "@/lib/auth/session";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { rateLimit } from "@/lib/rate-limit";

/**
 * Gap-audit P1 fix (Finding 2) — revokes exactly ONE session (see this
 * sibling folder's GET route for the list this acts on), replacing the
 * all-or-nothing revoke-sessions route as the primary way to end a
 * specific suspicious session while leaving the staff member's other,
 * legitimate sessions untouched. The bulk revoke-sessions route (staff/
 * [userId]/revoke-sessions) still exists for the "phone was stolen, kill
 * everything" case.
 *
 * Same (userId, restaurantId) role-grant scoping as every other
 * support-session route, PLUS the deleted session itself must belong to
 * userId (see destroySessionById) — two independent checks, so this can
 * never revoke a session that isn't both this restaurant's staff member's
 * AND the one the caller actually asked for.
 */
export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ restaurantId: string; userId: string; sessionId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const session = await requirePlatformPermission(PLATFORM_PERMISSIONS.MANAGE_SUPPORT);
    const { restaurantId, userId, sessionId } = await ctx.params;

    const limit = await rateLimit(`admin-revoke-session:${session.user.id}`, {
      limit: 30,
      windowMs: 10 * 60 * 1000,
    });
    if (!limit.allowed) {
      return NextResponse.json({ error: "Too many requests. Please wait a moment." }, { status: 429 });
    }

    const [grant] = await db
      .select({ id: userRoles.id })
      .from(userRoles)
      .where(and(eq(userRoles.userId, userId), eq(userRoles.restaurantId, restaurantId)))
      .limit(1);
    if (!grant) {
      return NextResponse.json(
        { error: "This user has no role at this restaurant." },
        { status: 404 },
      );
    }

    const revoked = await destroySessionById(sessionId, userId);
    if (!revoked) {
      return NextResponse.json({ error: "Session not found." }, { status: 404 });
    }

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "admin.staff_session_revoked",
      resourceType: "session",
      resourceId: sessionId,
      ipAddress: getClientIp(request),
      metadata: { targetUserId: userId },
    });

    return NextResponse.json({ revoked: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
