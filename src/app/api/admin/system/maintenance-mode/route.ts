import { NextResponse } from "next/server";
import { requirePlatformPermission } from "@/lib/rbac/guard";
import { PLATFORM_PERMISSIONS } from "@/lib/rbac/platform-permissions";
import { parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { setMaintenanceModeSchema } from "@/lib/validation/system";
import { setMaintenanceMode } from "@/lib/system/maintenance-mode-db";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Platform Control Center (Phase 10) — toggles platform-wide maintenance
 * mode. This is the "most sensitive op" the plan calls for break-glass
 * access around: enabling it blocks every tenant's dashboard/API access
 * except platform admins (see resolveRestaurantContext/dashboard layout's
 * maintenance check) — that admin exemption IS the break-glass path, and
 * every audit_logs entry written while it's active gets auto-tagged
 * `duringMaintenanceMode: true` (see audit.ts) for full traceability of
 * what was done under emergency access.
 */
export async function POST(request: Request) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const session = await requirePlatformPermission(PLATFORM_PERMISSIONS.MANAGE_SYSTEM);

    const parsed = await parseJsonBody(request, setMaintenanceModeSchema);
    if (!parsed.ok) return parsed.response;

    const enabled = parsed.data.enabled;
    await setMaintenanceMode({
      enabled,
      message: enabled ? (parsed.data.message ?? null) : null,
      reason: enabled ? parsed.data.reason : null,
      userId: session.user.id,
    });

    await recordAuditLog({
      restaurantId: null,
      userId: session.user.id,
      action: enabled ? "admin.maintenance_mode_enabled" : "admin.maintenance_mode_disabled",
      resourceType: "platform_system",
      ipAddress: getClientIp(request),
      metadata: enabled ? { message: parsed.data.message ?? null, reason: parsed.data.reason } : undefined,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
