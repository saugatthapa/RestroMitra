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
import { recordPaymentSchema } from "@/lib/validation/payments";
import { computeBillingSummary } from "@/lib/payments";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { rupeesToPaisa } from "@/lib/money";

/**
 * Records a payment against an order — the primary write path for cash-out
 * at the till, and for split bills (call this multiple times, once per
 * payer/method, until the order is fully paid). Requires EDIT_ORDER, same
 * permission that gates editing an order's items — recording what was paid
 * is part of ordinary order handling, not a privileged action the way a
 * refund is.
 *
 * The order's cached `payment_status` is recomputed and stored on every
 * call so list/board views can filter/display it without summing the
 * ledger on every read; computeBillingSummary() is the single source of
 * truth for that derivation, called here and in the GET detail route.
 *
 * The initial order SELECT takes a `FOR UPDATE` row lock (QA hardening
 * pass) — without it, two concurrent payment requests for the same order
 * (a double-click, or two staff members at once) can both read the same
 * "before" ledger, both pass the remaining-due check against it, and both
 * insert, jointly overpaying the order past its total. The lock forces the
 * second transaction to wait for the first to commit before it reads the
 * order/ledger, so it sees the first payment's effect and is correctly
 * evaluated against the true remaining due.
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
      PERMISSIONS.EDIT_ORDER,
    );

    const parsed = await parseJsonBody(request, recordPaymentSchema);
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
      if (order.status === "cancelled") {
        return {
          error: "Cannot record a payment against a cancelled order.",
          status: 400,
        } as const;
      }
      // QA hardening pass fixed this same gap on the order-status route but
      // missed payments/refunds — a branch-scoped waiter/cashier could
      // record a payment against an order belonging to a DIFFERENT branch
      // of the same restaurant. Same fix, same reasoning, applied here.
      await requireBranchAccess(session.user.id, restaurantId, order.branchId);

      const existingPayments = await tx
        .select({ amountInPaisa: payments.amountInPaisa, tipInPaisa: payments.tipInPaisa })
        .from(payments)
        .where(eq(payments.orderId, orderId))
        .orderBy(asc(payments.createdAt));

      const before = computeBillingSummary(
        order.totalInPaisa,
        existingPayments.map((p) => p.amountInPaisa),
        existingPayments.map((p) => p.tipInPaisa),
      );

      if (body.amount > before.remainingDueInPaisa) {
        return {
          error: `Amount exceeds the remaining due (Rs. ${(before.remainingDueInPaisa / 100).toFixed(2)}).`,
          status: 400,
        } as const;
      }

      const [payment] = await tx
        .insert(payments)
        .values({
          restaurantId,
          orderId,
          amountInPaisa: body.amount,
          method: body.method,
          receivedInPaisa: body.receivedAmount ?? null,
          tipInPaisa: body.tip ? rupeesToPaisa(body.tip) : 0,
          note: body.note || null,
          recordedByUserId: session.user.id,
        })
        .returning();

      const after = computeBillingSummary(
        order.totalInPaisa,
        [...existingPayments.map((p) => p.amountInPaisa), payment.amountInPaisa],
        [...existingPayments.map((p) => p.tipInPaisa), payment.tipInPaisa],
      );

      const [updatedOrder] = await tx
        .update(orders)
        .set({ paymentStatus: after.paymentStatus, updatedAt: new Date() })
        .where(and(eq(orders.id, orderId), eq(orders.restaurantId, restaurantId)))
        .returning();

      return { payment, order: updatedOrder, billing: after } as const;
    });

    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "payment.recorded",
      resourceType: "payment",
      resourceId: result.payment.id,
      ipAddress: getClientIp(request),
      metadata: {
        orderId,
        amountInPaisa: result.payment.amountInPaisa,
        method: result.payment.method,
        tipInPaisa: result.payment.tipInPaisa,
      },
    });

    return NextResponse.json(
      { payment: result.payment, order: result.order, billing: result.billing },
      { status: 201 },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
