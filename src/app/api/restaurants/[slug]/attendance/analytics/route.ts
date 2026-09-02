import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { FEATURES } from "@/lib/feature-catalog";
import {
  computeAndPersistAttendanceDayStatuses,
  getAttendanceAnalytics,
  getAttendanceDayStatuses,
} from "@/lib/attendance-analytics-db";
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
 *
 * Phase 17 — also requires FEATURES.STAFF_ATTENDANCE: analytics is part of
 * the advanced (gated) attendance suite, not the free clock-in/clock-out
 * baseline.
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

    // Phase 18 (Attendance overhaul, Track B — Daily status persistence) —
    // this GET is the on-demand "finalize now" moment for this period's
    // per-day present/late/no_show/on_leave/holiday classification (see
    // computeAndPersistAttendanceDayStatuses' own doc comment for why: no
    // cron/background-job infrastructure exists in this codebase to do it
    // any other way). The persisted rows are then read back via the
    // separate, computation-free getAttendanceDayStatuses — proving this
    // is a genuine stored-and-reused field, not a value computed once and
    // thrown away.
    await computeAndPersistAttendanceDayStatuses(restaurantId, periodStart, periodEnd, timezone, effectiveBranchId);
    const dayStatuses = await getAttendanceDayStatuses(restaurantId, periodStart, periodEnd, effectiveBranchId);

    return NextResponse.json({ staff, dayStatuses, periodStart, periodEnd });
  } catch (err) {
    return toErrorResponse(err);
  }
}
