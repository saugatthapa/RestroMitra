import { NextResponse } from "next/server";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { holidays, branches } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccessForNullableTarget } from "@/lib/rbac/guard";
import { FEATURES } from "@/lib/feature-catalog";
import { createHolidaySchema } from "@/lib/validation/leave";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * No permission gate beyond membership, same as attendance/leave-requests
 * GET — every staff member should be able to see upcoming holidays when
 * picking leave dates, not just managers.
 */
export async function GET(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug, undefined, {
      requireFeature: FEATURES.STAFF_ATTENDANCE,
    });

    const rows = await db
      .select({
        id: holidays.id,
        branchId: holidays.branchId,
        branchName: branches.name,
        date: holidays.date,
        name: holidays.name,
      })
      .from(holidays)
      .leftJoin(branches, eq(holidays.branchId, branches.id))
      .where(eq(holidays.restaurantId, restaurantId))
      .orderBy(asc(holidays.date))
      .limit(500);

    return NextResponse.json({ holidays: rows });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * MANAGE_STAFF-gated — same trust tier as attendance corrections/review,
 * not MANAGE_RESTAURANT_SETTINGS: declaring "we're closed this day" is a
 * day-to-day staffing call a manager routinely makes, not the structural
 * configuration tier selfieClockInRequired lives at.
 */
export async function POST(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug } = await ctx.params;
    const { session, restaurantId, role, branchId: grantedBranchId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_STAFF,
      { requireFeature: FEATURES.STAFF_ATTENDANCE },
    );

    const parsed = await parseJsonBody(request, createHolidaySchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;
    const branchId = data.branchId ?? null;

    // A branch-scoped manager can only declare a holiday for their own
    // branch, never restaurant-wide (that would affect branches they
    // don't have access to) and never another branch's.
    await requireBranchAccessForNullableTarget(session.user.id, restaurantId, branchId, {
      role,
      branchId: grantedBranchId,
    });

    // App-level duplicate guard (see the table's own schema comment for
    // why this isn't a DB constraint) — same date, same scope (both
    // restaurant-wide, or both this exact branch) is almost certainly a
    // double-submit, not a deliberate second holiday. `eq(col, null)`
    // would compile to `= NULL` (always false in SQL), so the
    // restaurant-wide case needs isNull() instead.
    const [dup] = await db
      .select({ id: holidays.id })
      .from(holidays)
      .where(
        and(
          eq(holidays.restaurantId, restaurantId),
          eq(holidays.date, data.date),
          branchId ? eq(holidays.branchId, branchId) : isNull(holidays.branchId),
        ),
      )
      .limit(1);
    if (dup) {
      return NextResponse.json({ error: "A holiday is already recorded for this date." }, { status: 409 });
    }

    const [record] = await db
      .insert(holidays)
      .values({ restaurantId, branchId, date: data.date, name: data.name, createdByUserId: session.user.id })
      .returning();

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "holiday.created",
      resourceType: "holiday",
      resourceId: record.id,
      ipAddress: getClientIp(request),
      metadata: { date: data.date, name: data.name, branchId },
    });

    return NextResponse.json({ record }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
