import "server-only";
import { eq, sql } from "drizzle-orm";
import type { Transaction } from "@/db";
import { kotCounters, orders } from "@/db/schema";
import { restaurantDate } from "@/lib/restaurant-date";

export type KotSequenceAssignment = {
  sequence: number;
  printedAt: Date;
};

/**
 * Assigns this order its daily Kitchen Order Ticket number — a small,
 * human-facing "ticket #N" counter that resets every day, distinct from
 * orderNumber (a globally-unique receipt identifier, not something a
 * cashier shouts across a kitchen). Idempotent: called every time a KOT is
 * generated for this order (first print AND every reprint), but only
 * actually assigns/increments on the very first call — a reprint just
 * returns the number already on the order.
 *
 * Must run inside the same transaction as whatever triggered ticket
 * generation (the pending -> confirmed status transition, see the orders
 * status route) so the assignment can't commit independently of the status
 * change it's tied to.
 *
 * The increment itself goes through kot_counters via an atomic upsert
 * (`INSERT ... ON CONFLICT DO UPDATE SET last_number = last_number + 1`) —
 * two tickets racing to be "today's first" still each get a distinct
 * number, since Postgres serializes the two UPDATEs on that row.
 *
 * `ticketDate` — and so which day's counter this ticket draws from — is
 * computed in the RESTAURANT's own timezone, not the server's UTC clock;
 * otherwise a ticket cut just after local midnight in Kathmandu (still
 * "yesterday" in UTC until 5:45am local) would draw from the wrong day's
 * counter and its number could collide with, or gap from, the previous
 * day's sequence.
 */
export async function assignKotSequence(
  tx: Transaction,
  params: { restaurantId: string; orderId: string; timezone: string },
): Promise<KotSequenceAssignment> {
  const [existing] = await tx
    .select({ kotSequence: orders.kotSequence, kotPrintedAt: orders.kotPrintedAt })
    .from(orders)
    .where(eq(orders.id, params.orderId))
    .limit(1);

  if (existing?.kotSequence != null && existing.kotPrintedAt) {
    return { sequence: existing.kotSequence, printedAt: existing.kotPrintedAt };
  }

  const ticketDate = restaurantDate(params.timezone);
  const [counter] = await tx
    .insert(kotCounters)
    .values({ restaurantId: params.restaurantId, ticketDate, lastNumber: 1 })
    .onConflictDoUpdate({
      target: [kotCounters.restaurantId, kotCounters.ticketDate],
      set: { lastNumber: sql`${kotCounters.lastNumber} + 1`, updatedAt: new Date() },
    })
    .returning({ lastNumber: kotCounters.lastNumber });

  const printedAt = new Date();
  await tx
    .update(orders)
    .set({ kotSequence: counter.lastNumber, kotPrintedAt: printedAt })
    .where(eq(orders.id, params.orderId));

  return { sequence: counter.lastNumber, printedAt };
}
