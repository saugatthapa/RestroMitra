import "server-only";
import type { Transaction } from "@/db";
import { orderStatusHistory } from "@/db/schema";
import type { OrderStatus } from "@/lib/order-status";

/**
 * Commercial Launch Phase B.1 — writes one row per real status transition,
 * in the SAME transaction as the orders.status UPDATE that caused it (see
 * the orders/[orderId]/status route). This is deliberately the single
 * choke point for these inserts — same "one choke point" shape as
 * recordStockMovement (inventory.ts) / recordLedgerEntry (ledger.ts) — so
 * every future caller of the status route's transaction writes history the
 * same way, and reports.ts's getOrderPerformanceStats can rely on there
 * being exactly one row per transition, never zero, never two.
 */
export async function recordOrderStatusHistory(
  tx: Transaction,
  params: {
    restaurantId: string;
    orderId: string;
    fromStatus: OrderStatus;
    toStatus: OrderStatus;
    changedByUserId?: string | null;
    reason?: string | null;
  },
) {
  const [row] = await tx
    .insert(orderStatusHistory)
    .values({
      restaurantId: params.restaurantId,
      orderId: params.orderId,
      fromStatus: params.fromStatus,
      toStatus: params.toStatus,
      changedByUserId: params.changedByUserId ?? null,
      reason: params.reason ?? null,
    })
    .returning();
  return row;
}
