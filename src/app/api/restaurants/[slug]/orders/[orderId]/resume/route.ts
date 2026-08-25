import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { orders } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { resumeOrder } from "@/lib/tables";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/** The symmetric inverse of hold/route.ts — see that route's own comment for the permission tier reasoning. */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string; orderId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, orderId } = await ctx.params;
    const { session, restaurantId, role, branchId: grantedBranchId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.EDIT_ORDER,
    );

    const existingRows = await db
      .select({ id: orders.id, branchId: orders.branchId })
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.restaurantId, restaurantId)))
      .limit(1);
    if (!existingRows[0]) {
      return NextResponse.json({ error: "Order not found." }, { status: 404 });
    }
    await requireBranchAccess(session.user.id, restaurantId, existingRows[0].branchId, {
      role,
      branchId: grantedBranchId,
    });

    const updated = await db.transaction((tx) => resumeOrder(tx, { restaurantId, orderId }));

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "order.resumed",
      resourceType: "order",
      resourceId: orderId,
      ipAddress: getClientIp(request),
      metadata: {},
    });

    return NextResponse.json({ order: updated });
  } catch (err) {
    return toErrorResponse(err);
  }
}
