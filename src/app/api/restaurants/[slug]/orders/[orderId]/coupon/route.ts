import { NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { orders, payments } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { applyCouponSchema } from "@/lib/validation/coupons";
import { resolveCoupon, redeemCoupon, unredeemCoupon, CouponError } from "@/lib/coupons";
import { computeOrderTotals } from "@/lib/order-adjustments";
import { computeBillingSummary } from "@/lib/payments";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { requireBranchAccess } from "@/lib/rbac/guard";

/**
 * Applies (POST) or removes (DELETE) a coupon on a single order. Coupons
 * share the SAME discount slot a manual discount uses (orders has exactly
 * one discountType/discountValue/discountInPaisa/discountReason) — see
 * order-adjustments/route.ts's own doc comment. Applying a coupon here sets
 * that slot to a "flat" discount pinned at the coupon's already-resolved
 * (and, for percentage coupons, already max-capped) paisa amount, via
 * computeOrderTotals with discountType: "flat" — this reuses the existing
 * pricing formula UNCHANGED rather than re-deriving it, and deliberately
 * avoids passing the coupon's own discountType/discountValue through
 * (a raw percentage recompute here would silently drop the max-discount
 * cap that resolveCoupon already applied).
 *
 * Gated APPLY_DISCOUNT — same trust tier as a manual discount, per
 * coupons/route.ts's own comment: redeeming a shared code is just another
 * way to grant a discount.
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
      PERMISSIONS.APPLY_DISCOUNT,
    );

    const parsed = await parseJsonBody(request, applyCouponSchema);
    if (!parsed.ok) return parsed.response;

    const result = await db.transaction(async (tx) => {
      // Same FOR UPDATE reasoning as the adjustments route — this must not
      // race a concurrent payment/adjustment/coupon-apply reading a stale
      // subtotal or netPaid figure.
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
        return { error: "Cannot apply a coupon to a cancelled order.", status: 400 } as const;
      }
      await requireBranchAccess(session.user.id, restaurantId, order.branchId, {
        role,
        branchId: grantedBranchId,
      });

      let resolved;
      try {
        resolved = await resolveCoupon(restaurantId, parsed.data.code, order.subtotalInPaisa);
      } catch (err) {
        if (err instanceof CouponError) {
          return { error: err.message, status: err.status } as const;
        }
        throw err;
      }

      // Replacing an already-applied coupon (re-running with a different
      // code, or the same one) releases the old redemption first so its
      // usage slot isn't permanently burned by this swap.
      if (order.appliedCouponId) {
        await unredeemCoupon(tx, {
          restaurantId,
          couponId: order.appliedCouponId,
          orderId,
        });
      }

      const totals = computeOrderTotals({
        subtotalInPaisa: order.subtotalInPaisa,
        taxInPaisa: order.taxInPaisa,
        discountType: "flat",
        discountValue: resolved.discountInPaisa,
        serviceChargeBasisPoints: order.serviceChargeBasisPoints,
      });

      const existingPayments = await tx
        .select({ amountInPaisa: payments.amountInPaisa })
        .from(payments)
        .where(eq(payments.orderId, orderId))
        .orderBy(asc(payments.createdAt));
      const netPaidInPaisa = existingPayments.reduce((sum, p) => sum + p.amountInPaisa, 0);

      if (netPaidInPaisa > totals.totalInPaisa) {
        return {
          error: `This coupon would drop the order's total to Rs. ${(totals.totalInPaisa / 100).toFixed(2)}, below the Rs. ${(netPaidInPaisa / 100).toFixed(2)} already collected. Issue a refund first if you need to apply it.`,
          status: 400,
        } as const;
      }

      await redeemCoupon(tx, {
        restaurantId,
        couponId: resolved.coupon.id,
        orderId,
        discountInPaisa: resolved.discountInPaisa,
        recordedByUserId: session.user.id,
      });

      const [updated] = await tx
        .update(orders)
        .set({
          appliedCouponId: resolved.coupon.id,
          discountType: "flat",
          discountValue: resolved.discountInPaisa,
          discountInPaisa: totals.discountInPaisa,
          discountReason: `Coupon: ${resolved.coupon.code}`,
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
        couponCode: resolved.coupon.code,
      } as const;
    });

    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "order.coupon_applied",
      resourceType: "order",
      resourceId: orderId,
      ipAddress: getClientIp(request),
      metadata: {
        couponCode: result.couponCode,
        discountInPaisa: result.order.discountInPaisa,
        totalInPaisa: result.order.totalInPaisa,
      },
    });

    return NextResponse.json({ order: result.order, billing: result.billing });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Removes a previously-applied coupon: releases its usage slot and clears
 * the order's discount slot back to none (service charge/tax untouched).
 * A no-op-but-200 if the order has no applied coupon, so a double-click
 * from the bill-view UI doesn't surface an error.
 */
export async function DELETE(
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

    const result = await db.transaction(async (tx) => {
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
      await requireBranchAccess(session.user.id, restaurantId, order.branchId, {
        role,
        branchId: grantedBranchId,
      });

      if (!order.appliedCouponId) {
        return { order, billing: null, alreadyRemoved: true } as const;
      }

      await unredeemCoupon(tx, {
        restaurantId,
        couponId: order.appliedCouponId,
        orderId,
      });

      const totals = computeOrderTotals({
        subtotalInPaisa: order.subtotalInPaisa,
        taxInPaisa: order.taxInPaisa,
        discountType: null,
        discountValue: null,
        serviceChargeBasisPoints: order.serviceChargeBasisPoints,
      });

      const existingPayments = await tx
        .select({ amountInPaisa: payments.amountInPaisa })
        .from(payments)
        .where(eq(payments.orderId, orderId))
        .orderBy(asc(payments.createdAt));

      const [updated] = await tx
        .update(orders)
        .set({
          appliedCouponId: null,
          discountType: null,
          discountValue: null,
          discountInPaisa: 0,
          discountReason: null,
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
        alreadyRemoved: false,
      } as const;
    });

    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    if (!result.alreadyRemoved) {
      await recordAuditLog({
        restaurantId,
        userId: session.user.id,
        action: "order.coupon_removed",
        resourceType: "order",
        resourceId: orderId,
        ipAddress: getClientIp(request),
        metadata: { totalInPaisa: result.order.totalInPaisa },
      });
    }

    return NextResponse.json({ order: result.order, billing: result.billing });
  } catch (err) {
    return toErrorResponse(err);
  }
}
