import { NextResponse } from "next/server";
import { requirePlatformPermission } from "@/lib/rbac/guard";
import { PLATFORM_PERMISSIONS } from "@/lib/rbac/platform-permissions";
import { toErrorResponse } from "@/lib/api-route-helpers";
import { getSystemHealth } from "@/lib/system/health-db";
import { getMaintenanceMode } from "@/lib/system/maintenance-mode-db";
import { rateLimit } from "@/lib/rate-limit";

/** Platform Control Center (Phase 10) — the /admin/system health page's data source. */
export async function GET() {
  try {
    const session = await requirePlatformPermission(PLATFORM_PERMISSIONS.MANAGE_SYSTEM);

    // QA hardening (P2 backlog) — see restaurants/route.ts's matching
    // comment; shares the same admin-read:user bucket.
    const limit = await rateLimit(`admin-read:user:${session.user.id}`, { limit: 120, windowMs: 60 * 1000 });
    if (!limit.allowed) {
      return NextResponse.json({ error: "Too many requests. Please wait a moment." }, { status: 429 });
    }

    const [health, maintenanceMode] = await Promise.all([getSystemHealth(), getMaintenanceMode()]);
    return NextResponse.json({ health, maintenanceMode });
  } catch (err) {
    return toErrorResponse(err);
  }
}
