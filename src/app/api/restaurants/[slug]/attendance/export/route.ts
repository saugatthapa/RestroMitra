import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { FEATURES } from "@/lib/feature-catalog";
import { getAttendanceExportRows } from "@/lib/attendance-analytics-db";
import { ATTENDANCE_DAY_STATUS_LABELS } from "@/lib/attendance-analytics";
import { restaurantDate } from "@/lib/restaurant-date";
import { toCsv } from "@/lib/csv";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Commercial completion pass — Data Export gap (attendance). Same
 * MANAGE_STAFF + FEATURES.STAFF_ATTENDANCE gating and same periodStart/
 * periodEnd default (restaurant-local calendar month so far) as GET
 * /attendance/analytics — see that route's own comment. Row shape comes
 * from getAttendanceExportRows (attendance-analytics-db.ts), the per-day
 * counterpart of that route's per-period aggregate.
 */
export async function GET(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const {
      session,
      restaurantId,
      role,
      timezone,
      branchId: grantedBranchId,
    } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_STAFF, {
      requireFeature: FEATURES.STAFF_ATTENDANCE,
    });

    const today = restaurantDate(timezone);
    const defaultPeriodStart = `${today.slice(0, 7)}-01`;

    const url = new URL(request.url);
    const requestedPeriodStart = url.searchParams.get("periodStart");
    const requestedPeriodEnd = url.searchParams.get("periodEnd");
    const hasValidRequestedPeriod =
      !!requestedPeriodStart &&
      !!requestedPeriodEnd &&
      ISO_DATE.test(requestedPeriodStart) &&
      ISO_DATE.test(requestedPeriodEnd) &&
      requestedPeriodStart <= requestedPeriodEnd;

    const periodStart = hasValidRequestedPeriod ? requestedPeriodStart! : defaultPeriodStart;
    const periodEnd = hasValidRequestedPeriod ? requestedPeriodEnd! : today;

    const requestedBranchId = url.searchParams.get("branchId");
    const effectiveBranchId = grantedBranchId ?? requestedBranchId;
    if (effectiveBranchId) {
      await requireBranchAccess(session.user.id, restaurantId, effectiveBranchId, {
        role,
        branchId: grantedBranchId,
      });
    }

    const rows = await getAttendanceExportRows(restaurantId, periodStart, periodEnd, timezone, effectiveBranchId);

    const csv = toCsv(rows, [
      { header: "Staff", value: (r) => r.fullName },
      { header: "Date", value: (r) => r.date },
      { header: "Status", value: (r) => ATTENDANCE_DAY_STATUS_LABELS[r.status] },
      { header: "Clock in", value: (r) => (r.clockInAt ? r.clockInAt.toISOString() : "") },
      { header: "Clock out", value: (r) => (r.clockOutAt ? r.clockOutAt.toISOString() : "") },
      { header: "Late (minutes)", value: (r) => (r.lateMinutes > 0 ? r.lateMinutes : "") },
    ]);

    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="attendance-${periodStart}-to-${periodEnd}.csv"`,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
