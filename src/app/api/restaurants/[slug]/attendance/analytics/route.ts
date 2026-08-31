import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { getAttendanceAnalytics } from "@/lib/attendance-analytics-db";
import { restaurantDate } from "@/lib/restaurant-date";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Phase 16 (Attendance overhaul, Track B — Analytics & payroll integration)
 * — MANAGE_STAFF-gated, unlike attendance/schedule/leave's own GET routes:
 * this is an aggregate, everyone's-figures-at-once view (a per-staff
 * roster table), not a "my own record" self-service one, so there's no
 * meaningful scoped-down view for someone without the permission to fall
 * back to — same trust tier as the payroll roster route.
 *
 * Defaults the window to the restaurant-local calendar month so far
 * (1st of this month through today) — same "This month" default the
 * Payroll tab already uses (see StaffBoard.tsx's firstOfMonthIso/
 * localDateIso, mirrored here server-side via restaurantDate since a
 * device's own clock isn't relevant to a route handler). ?periodStart=&
 * periodEnd= (YYYY-MM-DD, both required together) overrides it.
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
    } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_STAFF);

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

    // QA hardening pattern reused from payroll/staff and schedule's own GET
    // routes: a branch-scoped manager's own grant always wins over any
    // ?branchId= they pass; an unrestricted owner/manager may narrow to
    // one branch via ?branchId=, or see every branch by default.
    const requestedBranchId = url.searchParams.get("branchId");
    const effectiveBranchId = grantedBranchId ?? requestedBranchId;
    if (effectiveBranchId) {
      await requireBranchAccess(session.user.id, restaurantId, effectiveBranchId, {
        role,
        branchId: grantedBranchId,
      });
    }

    const staff = await getAttendanceAnalytics(restaurantId, periodStart, periodEnd, timezone, effectiveBranchId);

    return NextResponse.json({ staff, periodStart, periodEnd });
  } catch (err) {
    return toErrorResponse(err);
  }
}
