import "server-only";
import { eq } from "drizzle-orm";
import { db, type Transaction } from "@/db";
import { restaurants, subscriptionEvents } from "@/db/schema";
import { computeSubscriptionAccess, type SubscriptionAccess } from "@/lib/subscription";

/**
 * Reads a restaurant's current subscription state and, if its stored
 * status is still "trialing" but the trial has actually lapsed, performs
 * the one-time write that flips it to "expired" and logs the transition
 * — self-healing on read rather than needing a cron job this app has no
 * infrastructure for. Every subsequent call for that restaurant sees
 * `subscriptionStatus = "expired"` already and takes the cheap read-only
 * path (no write, no event) below.
 *
 * Called from requireActiveSubscription() (guard.ts) on essentially every
 * tenant-scoped API request, so the read path has to stay a single-row
 * lookup — the write only happens exactly once, at the moment a trial is
 * first discovered to be over.
 */
export async function reconcileSubscriptionStatus(
  restaurantId: string,
): Promise<SubscriptionAccess> {
  const [restaurant] = await db
    .select({
      subscriptionStatus: restaurants.subscriptionStatus,
      trialEndsAt: restaurants.trialEndsAt,
    })
    .from(restaurants)
    .where(eq(restaurants.id, restaurantId))
    .limit(1);

  if (!restaurant) {
    return { allowed: false, reason: "expired" };
  }

  const access = computeSubscriptionAccess(restaurant);

  if (restaurant.subscriptionStatus === "trialing" && access.reason === "trial_expired") {
    await db.transaction(async (tx) => {
      await tx
        .update(restaurants)
        .set({ subscriptionStatus: "expired" })
        .where(eq(restaurants.id, restaurantId));
      await tx.insert(subscriptionEvents).values({
        restaurantId,
        eventType: "trial_expired",
        fromStatus: "trialing",
        toStatus: "expired",
        note: "Automatically expired — trial end date passed.",
        performedByUserId: null,
      });
    });
  }

  return access;
}

/** Records a subscription_events row from inside an existing transaction. */
export async function recordSubscriptionEvent(
  tx: Transaction,
  entry: {
    restaurantId: string;
    eventType: (typeof subscriptionEvents.eventType.enumValues)[number];
    fromStatus?: (typeof subscriptionEvents.fromStatus.enumValues)[number] | null;
    toStatus?: (typeof subscriptionEvents.toStatus.enumValues)[number] | null;
    planKey?: (typeof subscriptionEvents.planKey.enumValues)[number] | null;
    note?: string | null;
    performedByUserId?: string | null;
  },
): Promise<void> {
  await tx.insert(subscriptionEvents).values({
    restaurantId: entry.restaurantId,
    eventType: entry.eventType,
    fromStatus: entry.fromStatus ?? null,
    toStatus: entry.toStatus ?? null,
    planKey: entry.planKey ?? null,
    note: entry.note ?? null,
    performedByUserId: entry.performedByUserId ?? null,
  });
}
