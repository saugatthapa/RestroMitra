import "server-only";
import { eq, sql } from "drizzle-orm";
import type { Transaction } from "@/db";
import { fiscalInvoiceCounters, orders } from "@/db/schema";

export type FiscalInvoiceAssignment = {
  number: number;
  assignedAt: Date;
};

/**
 * Gap-audit P2 fix (fiscal compliance) — assigns this order its gapless,
 * strictly-increasing fiscal invoice number, distinct from `orderNumber`
 * (see generateOrderNumber in orders.ts: date-prefixed + a random suffix,
 * fine for a human-facing receipt lookup key but NOT what a tax authority
 * means by "invoice number" — gaps and out-of-order numbers are exactly
 * what that random suffix allows). Mirrors assignKotSequence in kot.ts —
 * same shape, same reasoning, same atomic-upsert mechanism — so read that
 * function's own doc comment for the general pattern this follows.
 *
 * Idempotent: safe to call more than once for the same order (a caller
 * doesn't need to know whether this is the first attempt), but only ever
 * actually assigns/increments on the very first call — every later call
 * just returns the number already on the order, unchanged.
 *
 * WHEN this is called matters as much as HOW: this must only ever be
 * invoked at the point a bill goes final, not at order creation and not on
 * every print/reprint —
 *   - NOT at order creation: a fresh order is a draft. Its total can still
 *     change (items added/removed, a discount applied, a coupon redeemed,
 *     the order cancelled outright) right up until it's done. Handing out
 *     a fiscal invoice number for every draft would burn numbers on orders
 *     that never actually bill for that amount — or ever complete at all —
 *     which is precisely the kind of gap a fiscal sequence exists to rule
 *     out.
 *   - NOT on print: printing is view-only (OrderBillView's "Print bill"
 *     button just calls window.print() against data already fetched — no
 *     server round-trip at all) and can happen any number of times before
 *     and after a bill is actually settled; assigning here would hand out
 *     a fresh number on every reprint instead of the one true number for
 *     that bill.
 *   - AT "served -> completed": the one state-machine transition where an
 *     order's numbers are truly final — see order-status.ts, `completed`
 *     is terminal and only reachable from `served`, so this is also,
 *     usefully, a once-per-order call site (same idempotency argument the
 *     status route already relies on for loyalty points and the sales-
 *     ledger entry it books in that exact same transition). This function
 *     is called from that same transaction in the status route, right
 *     alongside those two.
 *
 * Must run inside the same transaction as the status transition that
 * triggered it, same reasoning as assignKotSequence: the number assignment
 * and the status change commit together, or neither does.
 *
 * The increment itself goes through fiscal_invoice_counters via an atomic
 * upsert (`INSERT ... ON CONFLICT (restaurant_id) DO UPDATE SET
 * last_number = last_number + 1`) — two bills finalizing at the same
 * instant still each get a distinct, contiguous number, since Postgres
 * serializes the two UPDATEs on that one row (see this function's own
 * concurrency test in fiscal-invoice.test.ts).
 */
export async function assignFiscalInvoiceNumber(
  tx: Transaction,
  params: { restaurantId: string; orderId: string },
): Promise<FiscalInvoiceAssignment> {
  const [existing] = await tx
    .select({
      fiscalInvoiceNumber: orders.fiscalInvoiceNumber,
      fiscalInvoiceAssignedAt: orders.fiscalInvoiceAssignedAt,
    })
    .from(orders)
    .where(eq(orders.id, params.orderId))
    .limit(1);

  if (existing?.fiscalInvoiceNumber != null && existing.fiscalInvoiceAssignedAt) {
    return { number: existing.fiscalInvoiceNumber, assignedAt: existing.fiscalInvoiceAssignedAt };
  }

  const [counter] = await tx
    .insert(fiscalInvoiceCounters)
    .values({ restaurantId: params.restaurantId, lastNumber: 1 })
    .onConflictDoUpdate({
      target: fiscalInvoiceCounters.restaurantId,
      set: { lastNumber: sql`${fiscalInvoiceCounters.lastNumber} + 1`, updatedAt: new Date() },
    })
    .returning({ lastNumber: fiscalInvoiceCounters.lastNumber });

  const assignedAt = new Date();
  await tx
    .update(orders)
    .set({ fiscalInvoiceNumber: counter.lastNumber, fiscalInvoiceAssignedAt: assignedAt })
    .where(eq(orders.id, params.orderId));

  return { number: counter.lastNumber, assignedAt };
}
