import { NextResponse } from "next/server";
import { requirePlatformPermission, getActivePlatformRoles } from "@/lib/rbac/guard";
import { PLATFORM_PERMISSIONS, roleHasPlatformPermission } from "@/lib/rbac/platform-permissions";
import { parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { startImpersonationSchema } from "@/lib/validation/impersonation";
import { startImpersonation, ImpersonationAlreadyActiveError } from "@/lib/auth/impersonation";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { rateLimit } from "@/lib/rate-limit";

/**
 * Platform Control Center (Phase 8) — starts a new impersonation session.
 * Requires IMPERSONATE_TENANT for read-only mode; "write" mode additionally
 * requires IMPERSONATE_TENANT_WRITE, checked explicitly below rather than
 * trusting the client's requested mode (spec item 6 — "support agents must
 * not automatically get write access" even if they craft the request body
 * themselves).
 */
export async function POST(request: Request) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const session = await requirePlatformPermission(PLATFORM_PERMISSIONS.IMPERSONATE_TENANT);

    const limit = rateLimit(`impersonation-start:${session.user.id}`, {
      limit: 10,
      windowMs: 10 * 60 * 1000,
    });
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "Too many impersonation attempts in a short time. Please wait a few minutes." },
        { status: 429 },
      );
    }

    const parsed = await parseJsonBody(request, startImpersonationSchema);
    if (!parsed.ok) return parsed.response;
    const { restaurantId, reason, mode } = parsed.data;

    if (mode === "write") {
      const roles = await getActivePlatformRoles(session.user.id);
      const canWrite = roles.some((role) =>
        roleHasPlatformPermission(role, PLATFORM_PERMISSIONS.IMPERSONATE_TENANT_WRITE),
      );
      if (!canWrite) {
        return NextResponse.json(
          { error: "You don't have permission to start a read/write impersonation session." },
          { status: 403 },
        );
      }
    }

    let context;
    try {
      context = await startImpersonation({
        adminUserId: session.user.id,
        targetRestaurantId: restaurantId,
        reason,
        mode,
        ipAddress: getClientIp(request),
        userAgent: request.headers.get("user-agent"),
      });
    } catch (err) {
      if (err instanceof ImpersonationAlreadyActiveError) {
        return NextResponse.json({ error: err.message }, { status: 409 });
      }
      if (err instanceof Error && err.message === "Restaurant not found.") {
        return NextResponse.json({ error: err.message }, { status: 404 });
      }
      throw err;
    }

    await recordAuditLog({
      restaurantId: context.targetRestaurantId,
      userId: session.user.id,
      action: "admin.impersonation_started",
      resourceType: "impersonation_session",
      resourceId: context.impersonationSessionId,
      ipAddress: getClientIp(request),
      metadata: { reason, mode, targetRestaurantName: context.targetRestaurantName },
    });

    return NextResponse.json({
      impersonation: {
        targetRestaurantId: context.targetRestaurantId,
        targetRestaurantName: context.targetRestaurantName,
        targetRestaurantSlug: context.targetRestaurantSlug,
        mode: context.mode,
        expiresAt: context.expiresAt.toISOString(),
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
