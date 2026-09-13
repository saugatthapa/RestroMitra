import "server-only";
import { and, asc, eq, notInArray } from "drizzle-orm";
import type { Transaction } from "@/db";
import { orders, payments } from "@/db/schema";
import { INACTIVE_ORDER_STATUSES, TableError, requireTableRowLock } from "@/lib/tables";
import { computeBillingSummary, type PaymentMethod } from "@/lib/payments";
import { assertRegisterOpenForCashPayment } from "@/lib/cash-register";
import { assertBusinessDayWritable } from "@/lib/daily-closing";
import { restaurantDate } from "@/lib/restaurant-date";

/**
 * "Combine bill" — Commercial Launch follow-up requested straight after
 * Table Merge shipped: merging a table only ever reassigns which table
 * each order sits on (see mergeTables in tables.ts), it never touches the
 * orders themselves, so a merged table can easily end up with two or more
 * separate active orders, each still needing its own payment. This is the
 * one place that settles all of them in a single cashier action: one
 * amount, one method, applied across every active order on the table.
 *
 * Deliberately NOT a rewrite of the single-order payments route (see
 * orders/[orderId]/payments/route.ts) — that route is the well-tested,
 * live payment path for the overwhelmingly common case (one order, one
 * bill) and touching it here isn't worth the risk. This is a new, narrow
 * primitive that reuses the same building blocks (computeBillingSummary,
 * assertRegisterOpenForCashPayment, assertBusinessDayWritable) rather than
 * re-deriving any of that math.
 *
 * Policy (confirmed with the restaurant): the entered amount pays off
 * orders OLDEST FIRST, each in full, before moving to the next — not a
 * proportional split across every order. If the amount doesn't cover
 * everything, the later order(s) are simply left partially paid rather
 * than every order ending up a little short.
 */

export type CombinedBillOrderSummary = {
  orderId: string;
  orderNumber: string;
  totalInPaisa: number;
  remainingDueInPaisa: number;
};

/**
 * Read-only view of a table's current combined bill — every active order
 * on it, plus the combined total/remaining-due a "Combine bill" screen
 * would show before anyone pays anything.
 */
export async function getCombinedBillForTable(
  tx: Transaction,
  params: { restaurantId: string; tableId: string },
): Promise<{ orders: CombinedBillOrderSummary[]; combinedRemainingDueInPaisa: number }> {
  const activeOrders = await tx
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.restaurantId, params.restaurantId),
        eq(orders.tableId, params.tableId),
        notInArray(orders.status, [...INACTIVE_ORDER_STATUSES]),
      ),
    )
    .orderBy(asc(orders.placedAt));

  const summaries: CombinedBillOrderSummary[] = [];
  for (const order of activeOrders) {
    const existingPayments = await tx
      .select({ amountInPaisa: payments.amountInPaisa, tipInPaisa: payments.tipInPaisa })
      .from(payments)
      .where(eq(payments.orderId, order.id));
    const billing = computeBillingSummary(
      order.totalInPaisa,
      existingPayments.map((p) => p.amountInPaisa),
      existingPayments.map((p) => p.tipInPaisa),
    );
    summaries.push({
      orderId: order.id,
      orderNumber: order.orderNumber,
      totalInPaisa: order.totalInPaisa,
      remainingDueInPaisa: billing.remainingDueInPaisa,
    });
  }

  return {
    orders: summaries,
    combinedRemainingDueInPaisa: summaries.reduce((sum, o) => sum + o.remainingDueInPaisa, 0),
  };
}

/**
 * Records ONE payment against every active order on a table, oldest order
 * first, each paid off in full before the next one gets anything (see the
 * module doc comment for why that policy, not a proportional split).
 *
 * Idempotency: `clientRequestId`, if given, is namespaced per order
 * (`${clientRequestId}:${orderId}`) before being handed to the same
 * (orderId, clientRequestId) unique index the single-order payments route
 * already relies on — so a resubmission of the exact same combined-payment
 * request replays each order's own already-recorded slice instead of
 * inserting a second time, however many orders were actually touched by
 * the original attempt. This is why the per-order allocation below is
 * driven by `dueBeforeThisAction` (this order's due PLUS whatever this same
 * clientRequestId already paid toward it) rather than by the order's
 * live remaining due — a live value would have already shrunk on replay,
 * making the exact same resubmitted amount look like an overpayment.
 */
export async function recordCombinedPayment(
  tx: Transaction,
  params: {
    restaurantId: string;
    tableId: string;
    amountInPaisa: number;
    method: PaymentMethod;
    note?: string | null;
    clientRequestId?: string | null;
    recordedByUserId: string;
    timezone: string;
    role?: string;
  },
): Promise<{
  branchId: string;
  touchedOrderIds: string[];
  payments: Array<{ orderId: string; amountInPaisa: number }>;
}> {
  if (!Number.isInteger(params.amountInPaisa) || params.amountInPaisa <= 0) {
    throw new TableError("Amount must be a positive whole-paisa amount.");
  }

  // Row-lock the table itself — not just its orders — so a concurrent
  // merge/transfer can't change which orders count as "on this table"
  // mid-transaction (same reasoning as mergeTables' own table-level lock).
  const table = await requireTableRowLock(tx, params.restaurantId, params.tableId);

  // Lock every active order on the table up front, oldest first — the
  // fixed settle order the policy above promises, and the same FOR UPDATE
  // discipline the single-order route takes on its one order.
  const activeOrders = await tx
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.restaurantId, params.restaurantId),
        eq(orders.tableId, params.tableId),
        notInArray(orders.status, [...INACTIVE_ORDER_STATUSES]),
      ),
    )
    .orderBy(asc(orders.placedAt))
    .for("update");

  if (activeOrders.length === 0) {
    throw new TableError("This table has no active orders to bill.");
  }

  if (params.method === "cash") {
    await assertRegisterOpenForCashPayment(tx, { restaurantId: params.restaurantId, branchId: table.branchId });
  }

  type Plan = {
    order: (typeof activeOrders)[number];
    existingPayments: Array<{ id: string; amountInPaisa: number; tipInPaisa: number; clientRequestId: string | null }>;
    derivedClientRequestId: string | null;
    alreadyRecorded: { id: string; amountInPaisa: number } | undefined;
    dueBeforeThisAction: number;
  };

  const plans: Plan[] = [];
  for (const order of activeOrders) {
    const existingPayments = await tx
      .select({
        id: payments.id,
        amountInPaisa: payments.amountInPaisa,
        tipInPaisa: payments.tipInPaisa,
        clientRequestId: payments.clientRequestId,
      })
      .from(payments)
      .where(eq(payments.orderId, order.id))
      .orderBy(asc(payments.createdAt));

    const derivedClientRequestId = params.clientRequestId ? `${params.clientRequestId}:${order.id}` : null;
    const alreadyRecorded = derivedClientRequestId
      ? existingPayments.find((p) => p.clientRequestId === derivedClientRequestId)
      : undefined;

    const billing = computeBillingSummary(
      order.totalInPaisa,
      existingPayments.map((p) => p.amountInPaisa),
      existingPayments.map((p) => p.tipInPaisa),
    );
    // Add back whatever THIS action already applied on a prior attempt —
    // see the doc comment above for why the live due alone isn't safe to
    // check a replay's resubmitted amount against.
    const dueBeforeThisAction = billing.remainingDueInPaisa + (alreadyRecorded?.amountInPaisa ?? 0);

    plans.push({ order, existingPayments, derivedClientRequestId, alreadyRecorded, dueBeforeThisAction });
  }

  const combinedDueBeforeThisAction = plans.reduce((sum, p) => sum + p.dueBeforeThisAction, 0);
  if (params.amountInPaisa > combinedDueBeforeThisAction) {
    throw new TableError(
      `Amount exceeds the combined remaining due (Rs. ${(combinedDueBeforeThisAction / 100).toFixed(2)}).`,
    );
  }

  let remaining = params.amountInPaisa;
  const touchedOrderIds: string[] = [];
  const recordedPayments: Array<{ orderId: string; amountInPaisa: number }> = [];

  for (const plan of plans) {
    if (plan.alreadyRecorded) {
      // This exact combined-payment attempt already settled this order —
      // replay its own recorded slice rather than re-deriving one.
      remaining -= plan.alreadyRecorded.amountInPaisa;
      touchedOrderIds.push(plan.order.id);
      recordedPayments.push({ orderId: plan.order.id, amountInPaisa: plan.alreadyRecorded.amountInPaisa });
      continue;
    }

    const portion = Math.min(remaining, plan.dueBeforeThisAction);
    if (portion <= 0) continue;

    await assertBusinessDayWritable(
      {
        userId: params.recordedByUserId,
        restaurantId: params.restaurantId,
        branchId: plan.order.branchId,
        businessDate: restaurantDate(params.timezone, plan.order.placedAt),
        role: params.role,
      },
      tx,
    );

    const [payment] = await tx
      .insert(payments)
      .values({
        restaurantId: params.restaurantId,
        orderId: plan.order.id,
        amountInPaisa: portion,
        method: params.method,
        note: params.note || null,
        clientRequestId: plan.derivedClientRequestId,
        recordedByUserId: params.recordedByUserId,
      })
      .returning();

    const after = computeBillingSummary(
      plan.order.totalInPaisa,
      [...plan.existingPayments.map((p) => p.amountInPaisa), payment.amountInPaisa],
      [...plan.existingPayments.map((p) => p.tipInPaisa), payment.tipInPaisa],
    );
    await tx
      .update(orders)
      .set({ paymentStatus: after.paymentStatus, updatedAt: new Date() })
      .where(eq(orders.id, plan.order.id));

    touchedOrderIds.push(plan.order.id);
    recordedPayments.push({ orderId: plan.order.id, amountInPaisa: portion });
    remaining -= portion;
  }

  return { branchId: table.branchId, touchedOrderIds, payments: recordedPayments };
}
