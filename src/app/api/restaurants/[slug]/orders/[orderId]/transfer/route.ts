import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { orders } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { transferOrderSchema } from "@/lib/validation/orders";
import { transferOrderToTable } from "@/lib/tables";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Commercial Launch Phase B.7 — Table Operations. Moves a single order onto
 * a different table (a party asked to move seats, a table needs to be
 * combined into a bigger one, etc.) — see transferOrderToTable's own
 * comment in src/lib/tables.ts for the CAS/branch/out-of-service rules.
 * Gated MANAGE_TABLES (manager/owner by default), same trust tier as
 * editing a table — moving orders between physical tables is a floor-plan
 * management action, not routine order handling.
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
      PERMISSIONS.MANAGE_TABLES,
    );

    const parsed = await parseJsonBody(request, transferOrderSchema);
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

    const result = await db.transaction((tx) =>
      transferOrderToTable(tx, { restaurantId, orderId, toTableId: parsed.data.toTableId }),
    );

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "order.transferred",
      resourceType: "order",
      resourceId: orderId,
      ipAddress: getClientIp(request),
      metadata: { fromTableId: result.fromTableId, toTableId: parsed.data.toTableId },
    });

    return NextResponse.json({ order: result.order });
  } catch (err) {
    return toErrorResponse(err);
  }
}
