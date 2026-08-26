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
import { restaurantDate } from "@/lib/restaurant-date";
import { assertBusinessDayWritable } from "@/lib/daily-closing";

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
 *
 * QA hardening pass (financial-atomicity audit) — that same lock is also
 * what makes the optional `clientRequestId` idempotency check below
 * race-safe with no retry loop needed, exactly as documented on the
 * sibling payments route: two requests carrying the same clientRequestId
 * for the same order are already serialized by the lock, so the second
 * one's post-lock lookup is guaranteed to see the first's committed
 * insert. The (orderId, clientRequestId) unique index on `payments` is
 * shared with regular payments (refunds are just negative-amount rows in
 * the same table) and is still there as a DB-level backstop.
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
    const { session, restaurantId, role, timezone, branchId: grantedBranchId } =
      await resolveRestaurantContext(slug, PERMISSIONS.REFUND_ORDER);

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
      await requireBranchAccess(session.user.id, restaurantId, order.branchId, {
        role,
        branchId: grantedBranchId,
      });

      // Daily Close Lock (Commercial Launch Phase A.2, spec section 10) —
      // once the business day this order was PLACED on has been closed
      // for this branch, an ordinary REFUND_ORDER holder (waiter/cashier/
      // manager in the default matrix) can no longer touch it; only
      // someone who ALSO holds MANAGE_DAILY_CLOSING (manager/accountant/
      // owner) may issue a late refund. This never blocks the refund
      // mechanism itself (still a new, audited, additive payments row —
      // the original transaction is never rewritten), only requires the
      // higher trust level once the period is locked.
      //
      // QA hardening pass — this was the ONLY mutation route with this
      // check inline; every other financial mutation had none at all. Now
      // routed through the centralized assertBusinessDayWritable (see its
      // own doc comment in daily-closing.ts), passing `tx` so the lock
      // check participates in the same transaction as this refund's write
      // rather than a separate connection.
      const orderBusinessDate = restaurantDate(timezone, order.placedAt);
      await assertBusinessDayWritable(
        {
          userId: session.user.id,
          restaurantId,
          branchId: order.branchId,
          businessDate: orderBusinessDate,
          role,
        },
        tx,
      );

      const existingPayments = await tx
        .select({
          id: payments.id,
          amountInPaisa: payments.amountInPaisa,
          clientRequestId: payments.clientRequestId,
        })
        .from(payments)
        .where(eq(payments.orderId, orderId))
        .orderBy(asc(payments.createdAt));

      // Idempotent replay — see the module doc comment above for why the
      // FOR UPDATE lock already makes this race-safe with no retry loop.
      if (body.clientRequestId) {
        const existing = existingPayments.find((p) => p.clientRequestId === body.clientRequestId);
        if (existing) {
          const [fullExisting] = await tx.select().from(payments).where(eq(payments.id, existing.id));
          const billing = computeBillingSummary(
            order.totalInPaisa,
            existingPayments.map((p) => p.amountInPaisa),
          );
          return { refund: fullExisting, order, billing, idempotentReplay: true } as const;
        }
      }

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
          clientRequestId: body.clientRequestId || null,
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

      return { refund, order: updatedOrder, billing: after, idempotentReplay: false } as const;
    });

    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    // A replayed request already recorded its audit-log entry the first
    // time it landed — logging again here would make it look like the
    // refund happened twice in the activity trail, even though only one
    // refund row exists.
    if (result.idempotentReplay) {
      return NextResponse.json(
        { refund: result.refund, order: result.order, billing: result.billing, idempotentReplay: true },
        { status: 200 },
      );
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
