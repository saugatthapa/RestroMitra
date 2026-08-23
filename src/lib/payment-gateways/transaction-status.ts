import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { paymentGatewayTransactions } from "@/db/schema";

/**
 * RC audit P0 fix — marks a gateway-transaction attempt "failed" (our
 * verification of the gateway's callback didn't check out), but ONLY if it
 * isn't already "completed". Extracted out of the callback route so this
 * exact guard is directly testable against a real database rather than
 * only provable by reading the route.
 *
 * Why the guard matters: the callback route can be hit more than once for
 * the same in-flight payment (a double-click, a browser retry, the gateway
 * itself re-delivering the redirect). Each hit verifies independently —
 * one might succeed (a real, correctly-verified completion) while another,
 * concurrent or later, hit fails its OWN verification (e.g. a transient
 * upstream lookup error). Without this guard, the failing hit's update
 * would silently overwrite the successful hit's "completed" status back to
 * "failed" — the money and the `payments` row from the real success stay
 * untouched, but the field this route's own idempotency fast-path reads
 * would now be wrong, so a follow-up page refresh would tell staff/guest
 * the payment failed when it had actually succeeded.
 *
 * Takes its own `FOR UPDATE` lock on the transaction row before deciding,
 * so it's safe under concurrent callback hits for the same reference —
 * whichever request's UPDATE (this one, or the success path's) commits
 * first is the one the other correctly defers to.
 */
export async function markGatewayTransactionFailed(
  transactionId: string,
  rawResponse: unknown,
): Promise<{ downgraded: boolean; finalStatus: string | null }> {
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ status: paymentGatewayTransactions.status })
      .from(paymentGatewayTransactions)
      .where(eq(paymentGatewayTransactions.id, transactionId))
      .for("update")
      .limit(1);
    if (!locked) return { downgraded: false, finalStatus: null };
    if (locked.status === "completed") {
      // A concurrent request already recorded a real success under this
      // same lock — leave it alone rather than clobbering it.
      return { downgraded: false, finalStatus: "completed" };
    }
    await tx
      .update(paymentGatewayTransactions)
      .set({ status: "failed", rawResponse: rawResponse ?? undefined, updatedAt: new Date() })
      .where(eq(paymentGatewayTransactions.id, transactionId));
    return { downgraded: true, finalStatus: "failed" };
  });
}
