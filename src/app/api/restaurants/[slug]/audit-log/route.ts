import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { listAuditLogs } from "@/lib/audit";
import { restaurantStartOfDay } from "@/lib/restaurant-date";

/**
 * RC audit P1 fix — recordAuditLog() (src/lib/audit.ts) has been writing to
 * audit_logs since Phase 2, called from 55+ route files covering every
 * sensitive action (refunds, voids, role/permission changes, salary
 * changes, expense lifecycle, inventory adjustments, settings changes) —
 * but there was never a read path for any of it: no GET endpoint, no
 * dashboard page. The backend work was already fully done; this closes the
 * read side. Query logic itself lives in listAuditLogs() (audit.ts) so it's
 * directly DB-integration-testable, same pattern as reports.ts.
 *
 * Gated behind MANAGE_STAFF — same trust tier as the Staff nav item this
 * sits next to in the sidebar, since the log surfaces exactly the kind of
 * staff-permission/role/salary changes that page already gates. Owner and
 * manager by default (see DEFAULT_ROLE_PERMISSIONS).
 *
 * `?limit=`/`?offset=` page through the log (newest first); `?action=`
 * narrows to actions starting with the given prefix (e.g. `?action=payment.`
 * for every payment/refund event); `?resourceType=` narrows to one resource
 * kind; `?from=`/`?to=` (YYYY-MM-DD, restaurant-local, inclusive) narrow the
 * date range, same half-open-range convention as the reports module.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId, timezone } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_STAFF,
    );

    const url = new URL(request.url);
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");

    const result = await listAuditLogs(restaurantId, {
      limit: Number(url.searchParams.get("limit")) || undefined,
      offset: Number(url.searchParams.get("offset")) || undefined,
      actionPrefix: url.searchParams.get("action") ?? undefined,
      resourceType: url.searchParams.get("resourceType") ?? undefined,
      createdFrom: from ? restaurantStartOfDay(timezone, from) : undefined,
      createdBefore: to
        ? new Date(restaurantStartOfDay(timezone, to).getTime() + 24 * 60 * 60 * 1000)
        : undefined,
    });

    return NextResponse.json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
