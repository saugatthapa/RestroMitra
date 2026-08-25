import { NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { orders, payments } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import {
  resolveRestaurantContext,
  parseJsonBody,
  toErrorResponse,
} from "@/lib/api-route-helpers";
import { orderAdjustmentsInputSchema, resolveOrderAdjustmentsInput } from "@/lib/validation/order-adjustments";
import { computeOrderTotals } from "@/lib/order-adjustments";
import { computeBillingSummary } from "@/lib/payments";
import { unredeemCoupon } from "@/lib/coupons";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { requireBranchAccess } from "@/lib/rbac/guard";

/**
 * Sets an existing order's discount + service charge — the "comp this
 * bill" / "add our standard 10% service charge" action, for orders that
 * weren't given a discount at creation time (or need it changed). Gated
 * behind APPLY_DISCOUNT (manager/owner by default), same trust tier as
 * REFUND_ORDER — this directly reduces (or, for service charge, increases)
 * what the restaurant collects.
 *
 * Whole-state, not a partial patch: the request body is the COMPLETE
 * desired discount + service charge configuration (see
 * orderAdjustmentsInputSchema's own comment) — sending `{}` clears any
 * existing discount and zeroes the service charge, it does not mean "leave
 * unchanged". This matches how the bill-view adjustment form always
 * submits its current full state.
 *
 * subtotalInPaisa/taxInPaisa are NEVER touched here — only the derived
 * discount/serviceCharge/total columns. See order-adjustments.ts's pricing
 * policy comment for why tax is never re-derived from a discount.
 */
export async function PATCH(
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
      PERMISSIONS.APPLY_DISCOUNT,
    );

    const parsed = await parseJsonBody(request, orderAdjustmentsInputSchema);
    if (!parsed.ok) return parsed.response;
    const resolved = resolveOrderAdjustmentsInput(parsed.data);

    const result = await db.transaction(async (tx) => {
      // Same FOR UPDATE reasoning as the payments route — this must not
      // race a concurrent payment/refund reading a stale netPaid figure.
      const orderRows = await tx
        .select()
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.restaurantId, restaurantId)))
        .for("update")
        .limit(1);
      const order = orderRows[0];
      if (!order) {
        return { error: "Order not found.", status: 404 } as const;
      }
      if (order.status === "cancelled") {
        return { error: "Cannot adjust a cancelled order.", status: 400 } as const;
      }
      await requireBranchAccess(session.user.id, restaurantId, order.branchId, {
        role,
        branchId: grantedBranchId,
      });

      const totals = computeOrderTotals({
        subtotalInPaisa: order.subtotalInPaisa,
        taxInPaisa: order.taxInPaisa,
        discountType: resolved.discountType,
        discountValue: resolved.discountValue,
        serviceChargeBasisPoints: resolved.serviceChargeBasisPoints,
      });

      const existingPayments = await tx
        .select({ amountInPaisa: payments.amountInPaisa })
        .from(payments)
        .where(eq(payments.orderId, orderId))
        .orderBy(asc(payments.createdAt));
      const netPaidInPaisa = existingPayments.reduce((sum, p) => sum + p.amountInPaisa, 0);

      // A discount can't retroactively make the bill smaller than what's
      // already been collected — that would look like an overpayment out
      // of nowhere. Direct staff to issue a refund first instead of
      // silently letting remainingDueInPaisa go negative (computeBillingSummary
      // clamps it to 0, which would just hide the mismatch).
      if (netPaidInPaisa > totals.totalInPaisa) {
        return {
          error: `This order's new total (Rs. ${(totals.totalInPaisa / 100).toFixed(2)}) would be less than the Rs. ${(netPaidInPaisa / 100).toFixed(2)} already collected. Issue a refund first if you need to reduce the bill below that.`,
          status: 400,
        } as const;
      }

      // This route sets the discount slot directly (manual discount, or
      // clearing it) — it's not coupon-aware. If a coupon is currently
      // occupying that slot, release its usage count before overwriting it,
      // same as the dedicated coupon-remove route does, so a manual
      // discount replacing a coupon doesn't permanently burn the coupon's
      // usage slot for no reason.
      if (order.appliedCouponId) {
        await unredeemCoupon(tx, {
          restaurantId,
          couponId: order.appliedCouponId,
          orderId,
        });
      }

      const [updated] = await tx
        .update(orders)
        .set({
          appliedCouponId: null,
          discountType: resolved.discountType,
          discountValue: resolved.discountValue,
          discountInPaisa: totals.discountInPaisa,
          discountReason: resolved.discountReason,
          serviceChargeBasisPoints: resolved.serviceChargeBasisPoints,
          serviceChargeInPaisa: totals.serviceChargeInPaisa,
          totalInPaisa: totals.totalInPaisa,
          paymentStatus: computeBillingSummary(totals.totalInPaisa, existingPayments.map((p) => p.amountInPaisa))
            .paymentStatus,
          updatedAt: new Date(),
        })
        .where(and(eq(orders.id, orderId), eq(orders.restaurantId, restaurantId)))
        .returning();

      return {
        order: updated,
        billing: computeBillingSummary(totals.totalInPaisa, existingPayments.map((p) => p.amountInPaisa)),
      } as const;
    });

    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "order.adjustments_changed",
      resourceType: "order",
      resourceId: orderId,
      ipAddress: getClientIp(request),
      metadata: {
        discountType: result.order.discountType,
        discountInPaisa: result.order.discountInPaisa,
        discountReason: result.order.discountReason,
        serviceChargeBasisPoints: result.order.serviceChargeBasisPoints,
        serviceChargeInPaisa: result.order.serviceChargeInPaisa,
        totalInPaisa: result.order.totalInPaisa,
      },
    });

    return NextResponse.json({ order: result.order, billing: result.billing });
  } catch (err) {
    return toErrorResponse(err);
  }
}
