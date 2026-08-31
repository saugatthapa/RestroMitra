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
  ctx: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await ctx.params;
    const { session, restaurantId, role, branchId: grantedBranchId } = await resolveRestaurantContext(slug);

    const canViewAll = await hasPermission(session.user.id, restaurantId, PERMISSIONS.MANAGE_STAFF, role);

    // Phase 11a: a branch-scoped viewer's own grant always wins; an
    // unrestricted manager/owner can narrow the roster to one branch via
    // ?branchId=, or see every branch (including un-scoped legacy records)
    // by default.
    const url = new URL(request.url);
    const requestedBranchId = url.searchParams.get("branchId");
    const effectiveBranchId = grantedBranchId ?? requestedBranchId;
    if (effectiveBranchId) {
      await requireBranchAccess(session.user.id, restaurantId, effectiveBranchId, {
        role,
        branchId: grantedBranchId,
      });
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
        clockInPhotoObjectKey: attendanceRecords.clockInPhotoObjectKey,
        clockOutPhotoObjectKey: attendanceRecords.clockOutPhotoObjectKey,
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

    // Phase 12 — the client only ever needs to know WHETHER a photo
    // exists (to decide whether to show a "view photo" button, which then
    // calls the dedicated signed-URL route); the object key itself is an
    // internal storage detail with no meaning to a client that can't sign
    // requests, so it's collapsed to a boolean here rather than exposed.
    const records = rows.map((r) => ({
      ...r,
      hasClockInPhoto: r.clockInPhotoObjectKey !== null,
      hasClockOutPhoto: r.clockOutPhotoObjectKey !== null,
      clockInPhotoObjectKey: undefined,
      clockOutPhotoObjectKey: undefined,
    }));

    return NextResponse.json({ records, canViewAll });
  } catch (err) {
    return toErrorResponse(err);
  }
}
