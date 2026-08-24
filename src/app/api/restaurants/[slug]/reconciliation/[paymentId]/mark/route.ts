import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { orders, payments } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { markPaymentReconciled } from "@/lib/financial-reconciliation";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * A human has checked their bank/gateway statement and confirmed this
 * payment settled — mark it reconciled. No request body: the payment id
 * comes from the URL, same shape as stock-transfers' approve/dispatch
 * routes.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string; paymentId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, paymentId } = await ctx.params;
    const {
      session,
      restaurantId,
      role,
      branchId: grantedBranchId,
    } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_ACCOUNT_BOOKS);

    // payments has no branchId of its own — resolve via its order, same
    // rationale as the reconciliation list/summary queries.
    const [existing] = await db
      .select({ id: payments.id, branchId: orders.branchId })
      .from(payments)
      .innerJoin(orders, eq(payments.orderId, orders.id))
      .where(and(eq(payments.id, paymentId), eq(payments.restaurantId, restaurantId)))
      .limit(1);
    if (!existing) {
      return NextResponse.json({ error: "Payment not found." }, { status: 404 });
    }
    await requireBranchAccess(session.user.id, restaurantId, existing.branchId, {
      role,
      branchId: grantedBranchId,
    });

    const updated = await db.transaction((tx) =>
      markPaymentReconciled(tx, { restaurantId, paymentId, reconciledByUserId: session.user.id }),
    );

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "payments.reconciled",
      resourceType: "payment",
      resourceId: paymentId,
      ipAddress: getClientIp(request),
    });

    return NextResponse.json({ payment: updated });
  } catch (err) {
    return toErrorResponse(err);
  }
}
