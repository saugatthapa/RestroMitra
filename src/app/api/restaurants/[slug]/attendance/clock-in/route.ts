import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { attendanceRecords } from "@/db/schema";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { clockInSchema } from "@/lib/validation/attendance";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Self-service clock-in — any active staff member for this restaurant, no
 * extra permission required (this is about the caller's OWN shift, not
 * anyone else's). Refuses to open a second shift on top of one already
 * open, since attendance_records.clockOutAt has no DB-level exclusion
 * constraint enforcing "at most one open shift" — this check is that
 * guarantee's only line of defense today (see schema.ts's comment).
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

    const [record] = await db
      .insert(attendanceRecords)
      .values({
        restaurantId,
        userId: session.user.id,
        // Phase 11a: stamped from the clocking-in user's own branch-scoped
        // grant when they have one; null (unscoped) for an owner/manager
        // whose grant spans every branch.
        branchId,
        note: parsed.data.note || null,
      })
      .returning();

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
