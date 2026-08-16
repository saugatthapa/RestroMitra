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
import { recordRefundSchema } from "@/lib/validation/payments";
import { computeBillingSummary, computeNetPaid } from "@/lib/payments";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { requireBranchAccess } from "@/lib/rbac/guard";

/**
 * Records a refund against an order, stored as a negative-amount row in the
 * same `payments` ledger (see schema.ts comment above the payments table).
 * Requires REFUND_ORDER — a step up from EDIT_ORDER/recording a payment,
 * since reversing money already taken needs the extra trust level (owner +
 * manager by default; see DEFAULT_ROLE_PERMISSIONS).
 *
 * Deliberately NOT blocked on order.status === "cancelled": refunding money
 * for an order that was cancelled after being paid is exactly the kind of
 * case this needs to handle, not reject.
 *
 * The initial order SELECT takes a `FOR UPDATE` row lock (QA hardening
 * pass, same reasoning as the payments route) — without it, two concurrent
 * refund requests can both read the same net-paid total, both pass the
 * over-refund check against it, and jointly refund more than was ever
 * actually paid.
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
    const { session, restaurantId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.REFUND_ORDER,
    );

    const parsed = await parseJsonBody(request, recordRefundSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

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
      // QA hardening pass fixed this same gap on the order-status route but
      // missed payments/refunds — a branch-scoped waiter/cashier could
      // refund an order belonging to a DIFFERENT branch of the same
      // restaurant. Same fix, same reasoning, applied here.
      await requireBranchAccess(session.user.id, restaurantId, order.branchId);

      const existingPayments = await tx
        .select({ id: payments.id, amountInPaisa: payments.amountInPaisa })
        .from(payments)
        .where(eq(payments.orderId, orderId))
        .orderBy(asc(payments.createdAt));

      const netPaidSoFar = computeNetPaid(existingPayments.map((p) => p.amountInPaisa));
      if (body.amount > netPaidSoFar) {
        return {
          error: `Refund exceeds the amount actually paid (Rs. ${(netPaidSoFar / 100).toFixed(2)}).`,
          status: 400,
        } as const;
      }

      if (body.refundOfPaymentId) {
        const target = existingPayments.find((p) => p.id === body.refundOfPaymentId);
        if (!target) {
          return { error: "The payment being refunded was not found on this order.", status: 404 } as const;
        }
      }

      const [refund] = await tx
        .insert(payments)
        .values({
          restaurantId,
          orderId,
          amountInPaisa: -body.amount,
          method: body.method,
          refundOfPaymentId: body.refundOfPaymentId ?? null,
          note: body.reason || null,
          recordedByUserId: session.user.id,
        })
        .returning();

      const after = computeBillingSummary(order.totalInPaisa, [
        ...existingPayments.map((p) => p.amountInPaisa),
        refund.amountInPaisa,
      ]);

      const [updatedOrder] = await tx
        .update(orders)
        .set({ paymentStatus: after.paymentStatus, updatedAt: new Date() })
        .where(and(eq(orders.id, orderId), eq(orders.restaurantId, restaurantId)))
        .returning();

      return { refund, order: updatedOrder, billing: after } as const;
    });

    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "payment.refunded",
      resourceType: "payment",
      resourceId: result.refund.id,
      ipAddress: getClientIp(request),
      metadata: {
        orderId,
        amountInPaisa: result.refund.amountInPaisa,
        method: result.refund.method,
        reason: body.reason || null,
      },
    });

    return NextResponse.json(
      { refund: result.refund, order: result.order, billing: result.billing },
      { status: 201 },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
