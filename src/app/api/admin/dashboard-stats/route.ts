import { NextResponse } from "next/server";
import { requirePlatformPermission } from "@/lib/rbac/guard";
import { PLATFORM_PERMISSIONS } from "@/lib/rbac/platform-permissions";
import { toErrorResponse } from "@/lib/api-route-helpers";
import { getDashboardMetrics } from "@/lib/admin/dashboard-metrics-db";
import { listPlatformAuditLogs } from "@/lib/audit";

const RECENT_ACTIVITY_LIMIT = 10;

/**
 * Gap-audit P1 fix (Finding 1) — the platform dashboard's data source: the
 * commercial metrics the founder asked for (total/active users, active
 * branches, orders today/this month, subscription revenue, plan
 * distribution, feature-usage counts) plus a recent-activity feed. Every
 * metric comes from a real, efficient aggregate query (see
 * dashboard-metrics-db.ts's own doc comment) — no per-restaurant loop, no
 * client-side aggregation of an unbounded list the way the old dashboard
 * derived its stats from the restaurant list response.
 *
 * Gated VIEW_TENANTS, same as the restaurant list route — every platform
 * role, including platform_viewer, can read this dashboard.
 */
export async function GET() {
  try {
    await requirePlatformPermission(PLATFORM_PERMISSIONS.VIEW_TENANTS);

    const [metrics, recentActivity] = await Promise.all([
      getDashboardMetrics(),
      listPlatformAuditLogs({ limit: RECENT_ACTIVITY_LIMIT }),
    ]);

    return NextResponse.json({ metrics, recentActivity: recentActivity.logs });
  } catch (err) {
    return toErrorResponse(err);
  }
}
