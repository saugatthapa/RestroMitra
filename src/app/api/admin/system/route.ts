import { NextResponse } from "next/server";
import { requirePlatformPermission } from "@/lib/rbac/guard";
import { PLATFORM_PERMISSIONS } from "@/lib/rbac/platform-permissions";
import { toErrorResponse } from "@/lib/api-route-helpers";
import { getSystemHealth } from "@/lib/system/health-db";
import { getMaintenanceMode } from "@/lib/system/maintenance-mode-db";

/** Platform Control Center (Phase 10) — the /admin/system health page's data source. */
export async function GET() {
  try {
    await requirePlatformPermission(PLATFORM_PERMISSIONS.MANAGE_SYSTEM);
    const [health, maintenanceMode] = await Promise.all([getSystemHealth(), getMaintenanceMode()]);
    return NextResponse.json({ health, maintenanceMode });
  } catch (err) {
    return toErrorResponse(err);
  }
}
