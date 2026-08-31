import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { attendanceRecords } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { FEATURES } from "@/lib/feature-catalog";
import { requireBranchAccessForNullableTarget } from "@/lib/rbac/guard";
import { setAttendanceStatusSchema } from "@/lib/validation/attendance";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Phase 13 (Attendance overhaul, Track B) — the owner/manager review call
 * on a shift: VERIFIED (the photo(s) genuinely show this person),
 * REJECTED (they don't — requires a reviewNote saying why), or back to
 * NEEDS_REVIEW (re-flagging something already decided, e.g. for a second
 * opinion). MANAGE_STAFF-gated, same trust tier as the correction route.
 *
 * Deliberately doesn't touch clockInAt/clockOutAt/note — a review call is
 * about whether the shift's identity evidence is trustworthy, not about
 * what the shift's times/note say. Use the sibling correction route
 * (PATCH .../attendance/[recordId]) for that.
 *
 * Phase 17 — also requires FEATURES.STAFF_ATTENDANCE: a review call is
 * only ever meaningful on a photo-bearing shift (a record with no photo
 * auto-verifies and never reaches "needs_review" — see
 * initialAttendanceStatus in attendance.ts), so this is part of the
 * advanced (gated) suite, unlike the sibling correction route above which
 * stays free on every plan.
 */
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ slug: string; recordId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, recordId } = await ctx.params;
    const { session, restaurantId, role, branchId: grantedBranchId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_STAFF,
      { requireFeature: FEATURES.STAFF_ATTENDANCE },
    );

    const [existing] = await db
      .select()
      .from(attendanceRecords)
      .where(and(eq(attendanceRecords.id, recordId), eq(attendanceRecords.restaurantId, restaurantId)))
      .limit(1);
    if (!existing) {
      return NextResponse.json({ error: "Attendance record not found." }, { status: 404 });
    }
    await requireBranchAccessForNullableTarget(session.user.id, restaurantId, existing.branchId, {
      role,
      branchId: grantedBranchId,
    });

    const parsed = await parseJsonBody(request, setAttendanceStatusSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;
    const reviewNote = data.reviewNote && data.reviewNote.length > 0 ? data.reviewNote : null;

    const [record] = await db
      .update(attendanceRecords)
      .set({
        status: data.status,
        reviewedByUserId: session.user.id,
        reviewedAt: new Date(),
        reviewNote,
      })
      .where(eq(attendanceRecords.id, recordId))
      .returning();

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "attendance.status_changed",
      resourceType: "attendance_record",
      resourceId: recordId,
      ipAddress: getClientIp(request),
      metadata: { from: existing.status, to: data.status, reviewNote },
    });

    return NextResponse.json({ record });
  } catch (err) {
    return toErrorResponse(err);
  }
}
