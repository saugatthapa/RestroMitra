import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { holidays } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccessForNullableTarget } from "@/lib/rbac/guard";
import { FEATURES } from "@/lib/feature-catalog";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ slug: string; holidayId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, holidayId } = await ctx.params;
    const { session, restaurantId, role, branchId: grantedBranchId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_STAFF,
      { requireFeature: FEATURES.STAFF_ATTENDANCE },
    );

    const [existing] = await db
      .select()
      .from(holidays)
      .where(and(eq(holidays.id, holidayId), eq(holidays.restaurantId, restaurantId)))
      .limit(1);
    if (!existing) {
      return NextResponse.json({ error: "Holiday not found." }, { status: 404 });
    }
    await requireBranchAccessForNullableTarget(session.user.id, restaurantId, existing.branchId, {
      role,
      branchId: grantedBranchId,
    });

    await db.delete(holidays).where(eq(holidays.id, holidayId));

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "holiday.deleted",
      resourceType: "holiday",
      resourceId: holidayId,
      ipAddress: getClientIp(request),
      metadata: { date: existing.date, name: existing.name },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
