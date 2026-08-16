import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { attendanceRecords, users } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { hasPermission, requireBranchAccess } from "@/lib/rbac/guard";

/**
 * No permission gate beyond ordinary restaurant membership — every staff
 * member can see attendance. What differs is SCOPE: someone holding
 * MANAGE_STAFF sees everyone's records (the roster view a manager needs);
 * anyone else only sees their own (self-service "when did I last clock
 * in" — not a window into coworkers' hours).
 */
export async function GET(
  request: Request,
  ctx: RouteContext<"/api/restaurants/[slug]/attendance">,
) {
  try {
    const { slug } = await ctx.params;
    const { session, restaurantId, branchId: grantedBranchId } = await resolveRestaurantContext(slug);

    const canViewAll = await hasPermission(session.user.id, restaurantId, PERMISSIONS.MANAGE_STAFF);

    // Phase 11a: a branch-scoped viewer's own grant always wins; an
    // unrestricted manager/owner can narrow the roster to one branch via
    // ?branchId=, or see every branch (including un-scoped legacy records)
    // by default.
    const url = new URL(request.url);
    const requestedBranchId = url.searchParams.get("branchId");
    const effectiveBranchId = grantedBranchId ?? requestedBranchId;
    if (effectiveBranchId) {
      await requireBranchAccess(session.user.id, restaurantId, effectiveBranchId);
    }

    const rows = await db
      .select({
        id: attendanceRecords.id,
        userId: attendanceRecords.userId,
        fullName: users.fullName,
        branchId: attendanceRecords.branchId,
        clockInAt: attendanceRecords.clockInAt,
        clockOutAt: attendanceRecords.clockOutAt,
        note: attendanceRecords.note,
      })
      .from(attendanceRecords)
      .innerJoin(users, eq(attendanceRecords.userId, users.id))
      .where(
        and(
          eq(attendanceRecords.restaurantId, restaurantId),
          canViewAll ? undefined : eq(attendanceRecords.userId, session.user.id),
          effectiveBranchId ? eq(attendanceRecords.branchId, effectiveBranchId) : undefined,
        ),
      )
      .orderBy(desc(attendanceRecords.clockInAt))
      .limit(200);

    return NextResponse.json({ records: rows, canViewAll });
  } catch (err) {
    return toErrorResponse(err);
  }
}
