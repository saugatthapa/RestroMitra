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
 *
 * RC audit — that same lock is also what makes the optional
 * `clientRequestId` idempotency check below race-safe with no retry loop
 * needed (unlike the orders route): two requests carrying the same
 * clientRequestId for the same order are already serialized by the lock,
 * so the second one's post-lock lookup is guaranteed to see the first's
 * committed insert, not a stale pre-commit view. The unique index on
 * (orderId, clientRequestId) is still there as a DB-level backstop.
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
      await requireBranchAccess(session.user.id, restaurantId, order.branchId, {
        role,
        branchId: grantedBranchId,
      });

      const existingPayments = await tx
        .select({
          id: payments.id,
          amountInPaisa: payments.amountInPaisa,
          tipInPaisa: payments.tipInPaisa,
          clientRequestId: payments.clientRequestId,
        })
        .from(payments)
        .where(eq(payments.orderId, orderId))
        .orderBy(asc(payments.createdAt));

      // Idempotent replay — see the module doc comment above for why the
      // FOR UPDATE lock already makes this race-safe with no retry loop.
      // Billing is recomputed from the full existing ledger (which already
      // includes the replayed payment) rather than returned as null, so
      // callers get the same response shape either way.
      if (body.clientRequestId) {
        const existing = existingPayments.find((p) => p.clientRequestId === body.clientRequestId);
        if (existing) {
          const [fullExisting] = await tx.select().from(payments).where(eq(payments.id, existing.id));
          const billing = computeBillingSummary(
            order.totalInPaisa,
            existingPayments.map((p) => p.amountInPaisa),
            existingPayments.map((p) => p.tipInPaisa),
          );
          return { payment: fullExisting, order, billing, idempotentReplay: true } as const;
        }
      }

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
          clientRequestId: body.clientRequestId || null,
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

      return { payment, order: updatedOrder, billing: after, idempotentReplay: false } as const;
    });

    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    // A replayed request already recorded its audit-log entry the first
    // time it landed — logging again here would make it look like the
    // payment happened twice in the activity trail, even though only one
    // payment row exists.
    if (result.idempotentReplay) {
      return NextResponse.json(
        { payment: result.payment, order: result.order, billing: result.billing, idempotentReplay: true },
        { status: 200 },
      );
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
