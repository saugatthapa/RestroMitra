import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/rbac/guard";
import { destroyOtherSessions } from "@/lib/auth/session";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { toErrorResponse } from "@/lib/api-route-helpers";

/**
 * RC audit P1 fix — plain self-service "log out everywhere else" action,
 * independent of a password change (change-password's own route also
 * calls destroyOtherSessions, but a user who just lost/forgot a device —
 * no reason to suspect their password specifically — shouldn't have to
 * change their password just to kick that device's session). The
 * caller's OWN session is deliberately kept alive.
 */
export async function POST(request: Request) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const session = await requireAuth();
    const revokedCount = await destroyOtherSessions(session.user.id, session.sessionId);

    await recordAuditLog({
      userId: session.user.id,
      action: "auth.logout_other_sessions",
      resourceType: "user",
      resourceId: session.user.id,
      ipAddress: getClientIp(request),
      metadata: { otherSessionsRevoked: revokedCount },
    });

    return NextResponse.json({ ok: true, otherSessionsRevoked: revokedCount });
  } catch (err) {
    return toErrorResponse(err);
  }
}
