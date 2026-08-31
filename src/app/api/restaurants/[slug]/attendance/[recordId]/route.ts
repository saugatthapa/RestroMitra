import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { attendanceRecords, attendanceCorrections } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccessForNullableTarget } from "@/lib/rbac/guard";
import { correctAttendanceRecordSchema } from "@/lib/validation/attendance";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

async function getOwnedRecord(restaurantId: string, recordId: string) {
  const rows = await db
    .select()
    .from(attendanceRecords)
    .where(and(eq(attendanceRecords.id, recordId), eq(attendanceRecords.restaurantId, restaurantId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Phase 13 (Attendance overhaul, Track B) — manager/owner correction of a
 * shift's recorded clock-in/out time or note, always with a reason (the
 * plan's "correction-with-reason audit trail"). MANAGE_STAFF-gated — this
 * is an owner/manager action on someone ELSE's (or their own, if they also
 * clock in) timesheet, not a self-service edit; letting staff freely edit
 * their own recorded hours would defeat the point of having recorded hours
 * at all. Every correction is written to attendance_corrections (a
 * full before/after ledger — see schema.ts's own comment) in the same
 * transaction as the record update, so the two can never disagree.
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
    );

    const existing = await getOwnedRecord(restaurantId, recordId);
    if (!existing) {
      return NextResponse.json({ error: "Attendance record not found." }, { status: 404 });
    }
    await requireBranchAccessForNullableTarget(session.user.id, restaurantId, existing.branchId, {
      role,
      branchId: grantedBranchId,
    });

    const parsed = await parseJsonBody(request, correctAttendanceRecordSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const nextClockInAt = data.clockInAt ? new Date(data.clockInAt) : existing.clockInAt;
    const nextClockOutAt = data.clockOutAt ? new Date(data.clockOutAt) : existing.clockOutAt;
    const nextNote = data.note !== undefined ? (data.note || null) : existing.note;

    if (nextClockOutAt && nextClockOutAt.getTime() <= nextClockInAt.getTime()) {
      return NextResponse.json(
        { error: "Clock-out must be after clock-in." },
        { status: 400 },
      );
    }

    // Note: this never sets clockOutAt to null (see the schema's own
    // comment — reopening a closed shift is out of scope for this phase),
    // so it can never collide with attendance_records_one_open_shift_
    // per_user_unique the way the clock-in route's race handling does.
    const record = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(attendanceRecords)
        .set({ clockInAt: nextClockInAt, clockOutAt: nextClockOutAt, note: nextNote })
        .where(eq(attendanceRecords.id, recordId))
        .returning();

      await tx.insert(attendanceCorrections).values({
        attendanceRecordId: recordId,
        restaurantId,
        correctedByUserId: session.user.id,
        reason: data.reason,
        previousClockInAt: existing.clockInAt,
        previousClockOutAt: existing.clockOutAt,
        previousNote: existing.note,
        newClockInAt: nextClockInAt,
        newClockOutAt: nextClockOutAt,
        newNote: nextNote,
      });

      return updated;
    });

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "attendance.corrected",
      resourceType: "attendance_record",
      resourceId: recordId,
      ipAddress: getClientIp(request),
      metadata: {
        reason: data.reason,
        previous: { clockInAt: existing.clockInAt, clockOutAt: existing.clockOutAt, note: existing.note },
        next: { clockInAt: nextClockInAt, clockOutAt: nextClockOutAt, note: nextNote },
      },
    });

    return NextResponse.json({ record });
  } catch (err) {
    return toErrorResponse(err);
  }
}
