import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { attendanceRecords } from "@/db/schema";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { clockOutSchema } from "@/lib/validation/attendance";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { resolveAttendancePhotoForClock } from "@/lib/attendance-photos-db";

export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(slug);

    const parsed = await parseJsonBody(request, clockOutSchema);
    if (!parsed.ok) return parsed.response;

    // Phase 12 — same photo verification/requirement as clock-in, for the
    // clock-out side of the shift (see resolveAttendancePhotoForClock's
    // own comment). Runs before the open-shift lookup so a rejected photo
    // never has a shift-mutation side effect to undo.
    const clockOutPhotoObjectKey = await resolveAttendancePhotoForClock({
      restaurantId,
      userId: session.user.id,
      kind: "clock_out",
      photoObjectKey: parsed.data.photoObjectKey,
    });

    const openRows = await db
      .select()
      .from(attendanceRecords)
      .where(
        and(
          eq(attendanceRecords.restaurantId, restaurantId),
          eq(attendanceRecords.userId, session.user.id),
          isNull(attendanceRecords.clockOutAt),
        ),
      )
      .limit(1);
    const open = openRows[0];
    if (!open) {
      return NextResponse.json({ error: "You're not currently clocked in." }, { status: 400 });
    }

    // RC audit P2 fix — the WHERE clause re-asserts `clockOutAt IS NULL`
    // (a compare-and-swap on that column), same pattern as the other
    // status-transition routes in this codebase. Without it, a double-tap
    // (the same request fired twice by a flaky connection, or two devices
    // clocking the same shift out) would both match the row read above and
    // both write, the second silently overwriting the first's `clockOutAt`
    // with a later timestamp — a low-stakes but still-real timesheet
    // inaccuracy with no constraint to catch it.
    const [record] = await db
      .update(attendanceRecords)
      .set({
        clockOutAt: new Date(),
        // Appended, not overwritten — preserves any note left at clock-in.
        note: parsed.data.note ? [open.note, parsed.data.note].filter(Boolean).join(" / ") : open.note,
        clockOutPhotoObjectKey,
      })
      .where(and(eq(attendanceRecords.id, open.id), isNull(attendanceRecords.clockOutAt)))
      .returning();

    if (!record) {
      return NextResponse.json({ error: "This shift was already clocked out." }, { status: 409 });
    }

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "attendance.clocked_out",
      resourceType: "attendance_record",
      resourceId: record.id,
      ipAddress: getClientIp(request),
    });

    return NextResponse.json({ record });
  } catch (err) {
    return toErrorResponse(err);
  }
}
