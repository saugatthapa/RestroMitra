import "server-only";
import { eq } from "drizzle-orm";
import type { Transaction } from "@/db";
import { restaurants } from "@/db/schema";

/**
 * The one gate every Phase 4 automatic-posting call site checks first — see
 * ACCOUNTING_PHASE_4_PLAN.md Part 1. Reads inside the caller's own
 * transaction so it sees a consistent snapshot alongside whatever else that
 * transaction is doing, and so a restaurant that enables automatic posting
 * mid-request can't land in an inconsistent half-posted state.
 *
 * Returns false (never throws) for a restaurant that hasn't enabled
 * automatic posting — that is the expected, common case for the vast
 * majority of existing restaurants, not an error condition.
 */
export async function isAutomaticPostingEnabled(tx: Transaction, restaurantId: string): Promise<boolean> {
  const [row] = await tx
    .select({ automaticPostingEnabledAt: restaurants.automaticPostingEnabledAt })
    .from(restaurants)
    .where(eq(restaurants.id, restaurantId))
    .limit(1);
  return Boolean(row?.automaticPostingEnabledAt);
}
