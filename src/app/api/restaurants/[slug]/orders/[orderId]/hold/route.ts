import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { orders } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { holdOrderSchema } from "@/lib/validation/orders";
import { holdOrder } from "@/lib/tables";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Commercial Launch Phase B.7 — Table Operations. Pauses an order's
 * forward progress (see the isOnHold column's own doc comment in
 * schema.ts, and the status route's guard rejecting most transitions while
 * held). Gated EDIT_ORDER, not MANAGE_TABLES — unlike transfer/merge
 * (floor-plan management), holding an order is routine order handling any
 * front-of-house staff already trusted to edit an order can do (e.g. "the
 * kitchen asked us to wait on table 4" doesn't need a manager).
 */
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

    const parsed = await parseJsonBody(request, holdOrderSchema);
    if (!parsed.ok) return parsed.response;

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

    const updated = await db.transaction((tx) =>
      holdOrder(tx, {
        restaurantId,
        orderId,
        userId: session.user.id,
        reason: parsed.data.reason?.trim() || null,
      }),
    );

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "order.held",
      resourceType: "order",
      resourceId: orderId,
      ipAddress: getClientIp(request),
      metadata: { reason: updated.holdReason },
    });

    return NextResponse.json({ order: updated });
  } catch (err) {
    return toErrorResponse(err);
  }
}
