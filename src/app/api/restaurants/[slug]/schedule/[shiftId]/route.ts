import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { scheduledShifts } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccessForNullableTarget } from "@/lib/rbac/guard";
import { updateScheduledShiftSchema } from "@/lib/validation/scheduling";
import { restaurantWallClockToUtc, restaurantTimeOfDay } from "@/lib/restaurant-date";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

async function getOwnedShift(restaurantId: string, shiftId: string) {
  const [row] = await db
    .select()
    .from(scheduledShifts)
    .where(and(eq(scheduledShifts.id, shiftId), eq(scheduledShifts.restaurantId, restaurantId)))
    .limit(1);
  return row ?? null;
}

/** MANAGE_STAFF-gated reschedule — see updateScheduledShiftSchema's own comment on why reassigning to a different staff member isn't supported here. */
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ slug: string; shiftId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, shiftId } = await ctx.params;
    const {
      session,
      restaurantId,
      role,
      branchId: grantedBranchId,
      timezone,
    } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_STAFF);

    const existing = await getOwnedShift(restaurantId, shiftId);
    if (!existing) {
      return NextResponse.json({ error: "Scheduled shift not found." }, { status: 404 });
    }
    await requireBranchAccessForNullableTarget(session.user.id, restaurantId, existing.branchId, {
      role,
      branchId: grantedBranchId,
    });

    const parsed = await parseJsonBody(request, updateScheduledShiftSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const nextShiftDate = data.shiftDate ?? existing.shiftDate;
    // startTime/endTime were never stored as-is (only the resulting
    // instants were) — restaurantTimeOfDay re-derives the restaurant-LOCAL
    // "HH:MM" a stored instant represents (never the instant's raw UTC
    // hour/minute — see that function's own comment for why that would be
    // a real bug) so a partial time-only update can fall back to the
    // unchanged side.
    const existingStartTime = data.startTime ?? restaurantTimeOfDay(timezone, existing.plannedStartAt);
    const existingEndTime = data.endTime ?? restaurantTimeOfDay(timezone, existing.plannedEndAt);

    const nextPlannedStartAt =
      data.shiftDate || data.startTime
        ? restaurantWallClockToUtc(timezone, nextShiftDate, existingStartTime)
        : existing.plannedStartAt;
    const nextPlannedEndAt =
      data.shiftDate || data.endTime
        ? restaurantWallClockToUtc(timezone, nextShiftDate, existingEndTime)
        : existing.plannedEndAt;

    if (nextPlannedEndAt.getTime() <= nextPlannedStartAt.getTime()) {
      return NextResponse.json(
        { error: "End time must be after start time (overnight shifts aren't supported yet)." },
        { status: 400 },
      );
    }

    const [record] = await db
      .update(scheduledShifts)
      .set({
        shiftDate: nextShiftDate,
        plannedStartAt: nextPlannedStartAt,
        plannedEndAt: nextPlannedEndAt,
        note: data.note !== undefined ? data.note || null : existing.note,
      })
      .where(eq(scheduledShifts.id, shiftId))
      .returning();

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "scheduled_shift.updated",
      resourceType: "scheduled_shift",
      resourceId: shiftId,
      ipAddress: getClientIp(request),
      metadata: { shiftDate: nextShiftDate },
    });

    return NextResponse.json({ record });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ slug: string; shiftId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, shiftId } = await ctx.params;
    const { session, restaurantId, role, branchId: grantedBranchId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_STAFF,
    );

    const existing = await getOwnedShift(restaurantId, shiftId);
    if (!existing) {
      return NextResponse.json({ error: "Scheduled shift not found." }, { status: 404 });
    }
    await requireBranchAccessForNullableTarget(session.user.id, restaurantId, existing.branchId, {
      role,
      branchId: grantedBranchId,
    });

    await db.delete(scheduledShifts).where(eq(scheduledShifts.id, shiftId));

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "scheduled_shift.deleted",
      resourceType: "scheduled_shift",
      resourceId: shiftId,
      ipAddress: getClientIp(request),
      metadata: { shiftDate: existing.shiftDate },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
