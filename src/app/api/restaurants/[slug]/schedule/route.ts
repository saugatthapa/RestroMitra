import { NextResponse } from "next/server";
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { db } from "@/db";
import { scheduledShifts, attendanceRecords, users, branches, userRoles } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { hasPermission, requireBranchAccess, requireBranchAccessForNullableTarget } from "@/lib/rbac/guard";
import { FEATURES } from "@/lib/feature-catalog";
import { createScheduledShiftSchema } from "@/lib/validation/scheduling";
import {
  restaurantDate,
  restaurantStartOfDay,
  restaurantEndOfDay,
  restaurantWallClockToUtc,
} from "@/lib/restaurant-date";
import { weekRangeContaining } from "@/lib/scheduling";
import { matchScheduleWithAttendance } from "@/lib/scheduling-db";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Phase 15 (Attendance overhaul, Track B — Scheduling). No permission gate
 * beyond ordinary restaurant membership — same scope rule as attendance's
 * and leave-requests' GET routes: MANAGE_STAFF sees everyone's schedule,
 * anyone else only their own. Defaults the window to the restaurant-local
 * week containing today; ?from=&to= (YYYY-MM-DD) widens or shifts it.
 */
export async function GET(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const {
      session,
      restaurantId,
      role,
      branchId: grantedBranchId,
      timezone,
    } = await resolveRestaurantContext(slug, undefined, { requireFeature: FEATURES.STAFF_ATTENDANCE });

    const canViewAll = await hasPermission(session.user.id, restaurantId, PERMISSIONS.MANAGE_STAFF, role);

    const url = new URL(request.url);
    const requestedBranchId = url.searchParams.get("branchId");
    const effectiveBranchId = grantedBranchId ?? requestedBranchId;
    if (effectiveBranchId) {
      await requireBranchAccess(session.user.id, restaurantId, effectiveBranchId, {
        role,
        branchId: grantedBranchId,
      });
    }

    const [defaultFrom, defaultTo] = weekRangeContaining(restaurantDate(timezone));
    const from = url.searchParams.get("from") ?? defaultFrom;
    const to = url.searchParams.get("to") ?? defaultTo;

    const shiftRows = await db
      .select({
        id: scheduledShifts.id,
        userId: scheduledShifts.userId,
        fullName: users.fullName,
        branchId: scheduledShifts.branchId,
        branchName: branches.name,
        shiftDate: scheduledShifts.shiftDate,
        plannedStartAt: scheduledShifts.plannedStartAt,
        plannedEndAt: scheduledShifts.plannedEndAt,
        note: scheduledShifts.note,
      })
      .from(scheduledShifts)
      .innerJoin(users, eq(scheduledShifts.userId, users.id))
      .leftJoin(branches, eq(scheduledShifts.branchId, branches.id))
      .where(
        and(
          eq(scheduledShifts.restaurantId, restaurantId),
          gte(scheduledShifts.shiftDate, from),
          lte(scheduledShifts.shiftDate, to),
          canViewAll ? undefined : eq(scheduledShifts.userId, session.user.id),
          effectiveBranchId ? eq(scheduledShifts.branchId, effectiveBranchId) : undefined,
        ),
      )
      .orderBy(asc(scheduledShifts.plannedStartAt));

    // Attendance is pulled for the same [from,to] window (at the instant
    // level, via restaurantStartOfDay/EndOfDay of the window's own edges)
    // so matchScheduleWithAttendance has every record it could possibly
    // need to pair against a shift in that window.
    const windowStart = restaurantStartOfDay(timezone, from);
    const windowEnd = restaurantEndOfDay(timezone, to);
    const relevantUserIds = canViewAll ? undefined : [session.user.id];

    const attendanceRows = await db
      .select({
        userId: attendanceRecords.userId,
        clockInAt: attendanceRecords.clockInAt,
        clockOutAt: attendanceRecords.clockOutAt,
      })
      .from(attendanceRecords)
      .where(
        and(
          eq(attendanceRecords.restaurantId, restaurantId),
          gte(attendanceRecords.clockInAt, windowStart),
          lte(attendanceRecords.clockInAt, windowEnd),
          relevantUserIds ? inArray(attendanceRecords.userId, relevantUserIds) : undefined,
        ),
      );

    const matched = matchScheduleWithAttendance(shiftRows, attendanceRows, timezone);
    const shifts = matched.map(({ shift, variance }) => ({ ...shift, variance }));

    return NextResponse.json({ shifts, canViewAll, from, to });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * MANAGE_STAFF-gated — planning who works when is a manager/owner task,
 * same trust tier as the roster itself. Branch-scoped: a branch-scoped
 * manager can only schedule a shift AT their own branch (or restaurant-
 * wide/unscoped, if they have that grant) — requireBranchAccessForNullable
 * Target on the schedule's OWN branchId enforces that, same as holidays'
 * POST route.
 */
export async function POST(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug } = await ctx.params;
    const {
      session,
      restaurantId,
      role,
      branchId: grantedBranchId,
      timezone,
    } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_STAFF, {
      requireFeature: FEATURES.STAFF_ATTENDANCE,
    });

    const parsed = await parseJsonBody(request, createScheduledShiftSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;
    const branchId = data.branchId ?? null;

    await requireBranchAccessForNullableTarget(session.user.id, restaurantId, branchId, {
      role,
      branchId: grantedBranchId,
    });

    const [targetStaff] = await db
      .select({ id: userRoles.id })
      .from(userRoles)
      .where(
        and(
          eq(userRoles.userId, data.userId),
          eq(userRoles.restaurantId, restaurantId),
          eq(userRoles.isActive, true),
        ),
      )
      .limit(1);
    if (!targetStaff) {
      return NextResponse.json({ error: "That staff member is not active at this restaurant." }, { status: 404 });
    }

    const plannedStartAt = restaurantWallClockToUtc(timezone, data.shiftDate, data.startTime);
    const plannedEndAt = restaurantWallClockToUtc(timezone, data.shiftDate, data.endTime);
    if (plannedEndAt.getTime() <= plannedStartAt.getTime()) {
      // Overnight shifts (end time past midnight) aren't supported this
      // phase — see validation/scheduling.ts's own comment on
      // updateScheduledShiftSchema for the same "no reopening/remapping,
      // keep it simple" restraint. A manager scheduling a genuine overnight
      // shift needs to split it across two shiftDate rows for now.
      return NextResponse.json(
        { error: "End time must be after start time (overnight shifts aren't supported yet)." },
        { status: 400 },
      );
    }

    const [record] = await db
      .insert(scheduledShifts)
      .values({
        restaurantId,
        userId: data.userId,
        branchId,
        shiftDate: data.shiftDate,
        plannedStartAt,
        plannedEndAt,
        note: data.note || null,
        createdByUserId: session.user.id,
      })
      .returning();

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "scheduled_shift.created",
      resourceType: "scheduled_shift",
      resourceId: record.id,
      ipAddress: getClientIp(request),
      metadata: { forUserId: data.userId, shiftDate: data.shiftDate, startTime: data.startTime, endTime: data.endTime },
    });

    return NextResponse.json({ record }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
