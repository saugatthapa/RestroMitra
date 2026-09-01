import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/rbac/guard";
import { toErrorResponse } from "@/lib/api-route-helpers";
import { getImpersonationContext, exitImpersonation } from "@/lib/auth/impersonation";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { rateLimit } from "@/lib/rate-limit";

/**
 * Platform Control Center (Phase 8) — one-click exit. Deliberately only
 * requires a valid MAIN session (requireAuth), not a specific platform
 * permission — an admin who started an impersonation session must always
 * be able to end it, even in the (should-be-impossible) case their
 * IMPERSONATE_TENANT grant was revoked mid-session. Ends only the
 * impersonation session resolved from ITS OWN cookie (see
 * exitImpersonation's own comment) — the admin's own platform login is
 * never touched.
 */
export async function POST(request: Request) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const session = await requireAuth();

    const limit = await rateLimit(`impersonation-exit:${session.user.id}`, {
      limit: 20,
      windowMs: 10 * 60 * 1000,
    });
    if (!limit.allowed) {
      return NextResponse.json({ error: "Too many requests. Please wait a moment." }, { status: 429 });
    }

    // Read the context BEFORE exiting (which clears the cookie) — needed
    // both to know whether there's anything to log, and because
    // recordAuditLog's own impersonation auto-tagging (see audit.ts) reads
    // the cookie too and would find nothing once it's cleared.
    const impersonation = await getImpersonationContext();
    if (impersonation && impersonation.adminUserId === session.user.id) {
      await exitImpersonation(session.user.id);
      await recordAuditLog({
        restaurantId: impersonation.targetRestaurantId,
        userId: session.user.id,
        action: "admin.impersonation_ended",
        resourceType: "impersonation_session",
        resourceId: impersonation.impersonationSessionId,
        ipAddress: getClientIp(request),
        metadata: {
          reason: impersonation.reason,
          mode: impersonation.mode,
          isImpersonated: true,
          impersonationSessionId: impersonation.impersonationSessionId,
          impersonationReason: impersonation.reason,
        },
      });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
