import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { platformImpersonationSessions, restaurants, users } from "@/db/schema";
import { requirePlatformPermission } from "@/lib/rbac/guard";
import { PLATFORM_PERMISSIONS } from "@/lib/rbac/platform-permissions";
import { parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { revokeImpersonationSchema } from "@/lib/validation/impersonation";
import { revokeImpersonationSession } from "@/lib/auth/impersonation";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { rateLimit } from "@/lib/rate-limit";

/**
 * Platform Control Center (Phase 8) — force-ends ANOTHER admin's active
 * impersonation session ("Revoke" in the platform dashboard). Gated on
 * MANAGE_SUPPORT (its catalog description already covers "session
 * revocation" — see platform-permissions.ts) rather than
 * IMPERSONATE_TENANT itself: being ABLE to impersonate doesn't imply being
 * allowed to force-end someone else's session.
 */
export async function POST(request: Request) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const session = await requirePlatformPermission(PLATFORM_PERMISSIONS.MANAGE_SUPPORT);

    const limit = await rateLimit(`impersonation-revoke:${session.user.id}`, {
      limit: 20,
      windowMs: 10 * 60 * 1000,
    });
    if (!limit.allowed) {
      return NextResponse.json({ error: "Too many requests. Please wait a moment." }, { status: 429 });
    }

    const parsed = await parseJsonBody(request, revokeImpersonationSchema);
    if (!parsed.ok) return parsed.response;
    const { sessionId } = parsed.data;

    const [existing] = await db
      .select({
        id: platformImpersonationSessions.id,
        targetRestaurantId: platformImpersonationSessions.targetRestaurantId,
        targetRestaurantName: restaurants.name,
        reason: platformImpersonationSessions.reason,
        adminUserId: platformImpersonationSessions.adminUserId,
        // RC audit P1 fix (impersonation events rendering as raw JSON) —
        // the audit log UI's readable-sentence formatter names whose
        // session this was and how long it ran; both are one cheap extra
        // join/column away rather than a second query.
        adminFullName: users.fullName,
        startedAt: platformImpersonationSessions.startedAt,
        status: platformImpersonationSessions.status,
      })
      .from(platformImpersonationSessions)
      .innerJoin(restaurants, eq(platformImpersonationSessions.targetRestaurantId, restaurants.id))
      .innerJoin(users, eq(platformImpersonationSessions.adminUserId, users.id))
      .where(eq(platformImpersonationSessions.id, sessionId))
      .limit(1);

    if (!existing) {
      return NextResponse.json({ error: "Impersonation session not found." }, { status: 404 });
    }
    if (existing.status !== "active") {
      return NextResponse.json({ error: "This session is no longer active." }, { status: 409 });
    }

    const revoked = await revokeImpersonationSession(sessionId, session.user.id);
    if (!revoked) {
      return NextResponse.json({ error: "This session is no longer active." }, { status: 409 });
    }

    await recordAuditLog({
      restaurantId: existing.targetRestaurantId,
      userId: session.user.id,
      action: "admin.impersonation_revoked",
      resourceType: "impersonation_session",
      resourceId: existing.id,
      ipAddress: getClientIp(request),
      metadata: {
        reason: existing.reason,
        revokedAdminUserId: existing.adminUserId,
        revokedAdminName: existing.adminFullName,
        isImpersonated: true,
        impersonationSessionId: existing.id,
        impersonationReason: existing.reason,
        targetRestaurantName: existing.targetRestaurantName,
        durationMs: Date.now() - existing.startedAt.getTime(),
      },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
