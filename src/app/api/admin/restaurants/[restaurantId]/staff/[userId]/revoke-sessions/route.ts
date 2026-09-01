import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { userRoles } from "@/db/schema";
import { requirePlatformPermission } from "@/lib/rbac/guard";
import { PLATFORM_PERMISSIONS } from "@/lib/rbac/platform-permissions";
import { toErrorResponse } from "@/lib/api-route-helpers";
import { destroyAllSessions } from "@/lib/auth/session";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { rateLimit } from "@/lib/rate-limit";

/**
 * Platform Control Center (Phase 9) — support-driven session revocation:
 * "this staff member's phone was stolen," "we suspect this account is
 * compromised" — logs the user out everywhere immediately, on THEIR next
 * request (see destroyAllSessions's own doc comment; same function the
 * self-service forgot-password flow already uses).
 *
 * Scoped to (userId, restaurantId) together — the target must actually
 * hold (or have held) a role at this restaurant — so this can't be used
 * to blindly nuke an arbitrary user's sessions by guessing an id; it's
 * reachable only from this restaurant's own admin detail view.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ restaurantId: string; userId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const session = await requirePlatformPermission(PLATFORM_PERMISSIONS.MANAGE_SUPPORT);
    const { restaurantId, userId } = await ctx.params;

    const limit = await rateLimit(`admin-revoke-sessions:${session.user.id}`, {
      limit: 20,
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

    const revoked = await destroyAllSessions(userId);

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "admin.staff_sessions_revoked",
      resourceType: "user",
      resourceId: userId,
      ipAddress: getClientIp(request),
      metadata: { sessionsRevoked: revoked },
    });

    return NextResponse.json({ sessionsRevoked: revoked });
  } catch (err) {
    return toErrorResponse(err);
  }
}
