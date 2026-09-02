import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { attendanceRecords } from "@/db/schema";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { clockInSchema } from "@/lib/validation/attendance";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { isUniqueViolation } from "@/lib/db-error";
import { resolveAttendancePhotoForClock } from "@/lib/attendance-photos-db";
import { initialAttendanceStatus } from "@/lib/attendance";

/**
 * Self-service clock-in — any active staff member for this restaurant, no
 * extra permission required (this is about the caller's OWN shift, not
 * anyone else's). Refuses to open a second shift on top of one already
 * open.
 *
 * The up-front SELECT is a plain read-then-write with no locking, so on
 * its own it's only a best-effort check — two clock-in requests from the
 * same user close enough together (a double-tap, or a flaky-connection
 * retry) can both pass it before either INSERT commits. The actual
 * guarantee is `attendance_records_one_open_shift_per_user_unique` (see
 * schema.ts) — a partial unique index on (user_id, restaurant_id) WHERE
 * clock_out_at IS NULL. The loser of that race gets a 23505 back from
 * Postgres, caught below and turned into the same friendly "already
 * clocked in" response the SELECT path returns.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug } = await ctx.params;
    const { session, restaurantId, branchId } = await resolveRestaurantContext(slug);

    const parsed = await parseJsonBody(request, clockInSchema);
    if (!parsed.ok) return parsed.response;

    // Phase 12 — verifies (or requires, per this restaurant's own
    // selfieClockInRequired toggle) a selfie before the shift opens. Runs
    // before the open-shift check below so a rejected/unverifiable photo
    // never has a side effect to undo — nothing has been written yet.
    const clockInPhotoObjectKey = await resolveAttendancePhotoForClock({
      restaurantId,
      userId: session.user.id,
      kind: "clock_in",
      photoObjectKey: parsed.data.photoObjectKey,
    });
    // P2 gap-audit fix — the separate, always-optional workplace photo;
    // same resolver, gated by workplacePhotoRequired instead. Also runs
    // before the open-shift check for the same "no side effect to undo"
    // reason as the selfie resolve above.
    const clockInWorkplacePhotoObjectKey = await resolveAttendancePhotoForClock({
      restaurantId,
      userId: session.user.id,
      kind: "clock_in_workplace",
      photoObjectKey: parsed.data.workplacePhotoObjectKey,
    });

    const open = await db
      .select({ id: attendanceRecords.id })
      .from(attendanceRecords)
      .where(
        and(
          eq(attendanceRecords.restaurantId, restaurantId),
          eq(attendanceRecords.userId, session.user.id),
          isNull(attendanceRecords.clockOutAt),
        ),
      )
      .limit(1);
    if (open.length > 0) {
      return NextResponse.json(
        { error: "You're already clocked in. Clock out first." },
        { status: 400 },
      );
    }

    let record: typeof attendanceRecords.$inferSelect;
    try {
      const [inserted] = await db
        .insert(attendanceRecords)
        .values({
          restaurantId,
          userId: session.user.id,
          // Phase 11a: stamped from the clocking-in user's own branch-scoped
          // grant when they have one; null (unscoped) for an owner/manager
          // whose grant spans every branch.
          branchId,
          note: parsed.data.note || null,
          clockInPhotoObjectKey,
          clockInWorkplacePhotoObjectKey,
          // Phase 13 — see initialAttendanceStatus's own comment. Only the
          // selfie's presence drives review status, unchanged by this
          // P2 fix — the workplace photo is additional evidence attached
          // to the record for a manager to look at, not itself a trigger
          // for the needs_review workflow (see initialAttendanceStatus's
          // own doc comment on what it verifies: WHO clocked in, which
          // the workplace photo doesn't speak to).
          status: initialAttendanceStatus(clockInPhotoObjectKey !== null),
        })
        .returning();
      record = inserted;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Lost the race against a concurrent clock-in from the same user —
      // an open shift now exists (either the other request's, or this
      // user genuinely is already clocked in). Same friendly response
      // either way; there is nothing this request should retry.
      return NextResponse.json(
        { error: "You're already clocked in. Clock out first." },
        { status: 400 },
      );
    }

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "attendance.clocked_in",
      resourceType: "attendance_record",
      resourceId: record.id,
      ipAddress: getClientIp(request),
    });

    return NextResponse.json({ record }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
