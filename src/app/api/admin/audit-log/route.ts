import { NextResponse } from "next/server";
import { requirePlatformPermission } from "@/lib/rbac/guard";
import { PLATFORM_PERMISSIONS } from "@/lib/rbac/platform-permissions";
import { toErrorResponse } from "@/lib/api-route-helpers";
import { listPlatformAuditLogs } from "@/lib/audit";

/**
 * Platform Control Center (Phase 6) — the platform-wide audit log viewer's
 * data source. `?restaurantId=` narrows to one tenant's events;
 * `?restaurantId=platform` narrows to platform-only events (role grants,
 * plan/flag edits, and anything else with no single tenant); omit for
 * every event across the whole platform. `?limit=`/`?offset=` page
 * (newest first); `?action=` narrows to actions starting with the given
 * prefix; `?resourceType=` narrows to one resource kind; `?from=`/`?to=`
 * (YYYY-MM-DD, UTC, both inclusive) narrow the date range — UTC rather
 * than restaurant-local (as the tenant-scoped audit log
 * route uses) since this view spans every tenant, each potentially in a
 * different timezone, with no single one to resolve against.
 *
 * Gated VIEW_PLATFORM_AUDIT_LOG — held by support_admin and billing_admin
 * by default, alongside the two full-access roles.
 */
export async function GET(request: Request) {
  try {
    await requirePlatformPermission(PLATFORM_PERMISSIONS.VIEW_PLATFORM_AUDIT_LOG);

    const url = new URL(request.url);
    const restaurantIdParam = url.searchParams.get("restaurantId");
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");

    const result = await listPlatformAuditLogs({
      restaurantId: restaurantIdParam === "platform" ? null : (restaurantIdParam ?? undefined),
      limit: Number(url.searchParams.get("limit")) || undefined,
      offset: Number(url.searchParams.get("offset")) || undefined,
      actionPrefix: url.searchParams.get("action") ?? undefined,
      resourceType: url.searchParams.get("resourceType") ?? undefined,
      createdFrom: from ? new Date(`${from}T00:00:00.000Z`) : undefined,
      createdBefore: to ? new Date(new Date(`${to}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000) : undefined,
    });

    return NextResponse.json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
