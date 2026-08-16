import "server-only";
import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import type { Transaction } from "@/db";
import { customers, loyaltyTransactions } from "@/db/schema";
import { HttpError } from "@/lib/http-error";
import { computeVisitStreakUpdate, VISIT_STREAK_MILESTONE_POINTS } from "@/lib/loyalty-streaks";
import { BIRTHDAY_BONUS_POINTS, shouldAwardBirthdayBonus } from "@/lib/loyalty-birthday";

export class LoyaltyError extends HttpError {
  constructor(message: string) {
    super(message, 400);
  }
}

export type LoyaltyTransactionType = "earn" | "redeem" | "adjustment";

/** 1 loyalty point per Rs 10 (1000 paisa) spent on a completed order — a fixed, platform-wide MVP rate (see PHASE_8b_NOTES.md). */
export const POINTS_EARN_RATE_PAISA = 1000;

export function computePointsEarned(totalInPaisa: number): number {
  return Math.floor(totalInPaisa / POINTS_EARN_RATE_PAISA);
}

/**
 * The single choke point for changing a customer's loyalty point balance.
 * Inserts a row into the loyalty_transactions ledger AND atomically
 * updates the customer's cached loyaltyPointsBalance in the same SQL
 * statement (`balance += delta`, not a read-then-write in JS) — same
 * "ledger + atomic cache update" pattern as
 * src/lib/inventory.ts's recordStockMovement and src/lib/payments.ts.
 *
 * lifetimePointsEarned only ever goes up, and only for positive "earn"
 * transactions — redemptions and negative adjustments reduce the spendable
 * balance without reducing lifetime standing (see loyalty-tiers.ts).
 */
export async function recordLoyaltyTransaction(
  tx: Transaction,
  params: {
    restaurantId: string;
    customerId: string;
    type: LoyaltyTransactionType;
    pointsDelta: number;
    referenceType?: string | null;
    referenceId?: string | null;
    note?: string | null;
    recordedByUserId?: string | null;
  },
) {
  if (params.pointsDelta === 0) {
    throw new LoyaltyError("A loyalty transaction must have a non-zero point delta.");
  }

  const [transaction] = await tx
    .insert(loyaltyTransactions)
    .values({
      restaurantId: params.restaurantId,
      customerId: params.customerId,
      type: params.type,
      pointsDelta: params.pointsDelta,
      referenceType: params.referenceType ?? null,
      referenceId: params.referenceId ?? null,
      note: params.note ?? null,
      recordedByUserId: params.recordedByUserId ?? null,
    })
    .returning();

  const lifetimeIncrement = params.type === "earn" && params.pointsDelta > 0 ? params.pointsDelta : 0;

  const [updatedCustomer] = await tx
    .update(customers)
    .set({
      loyaltyPointsBalance: sql`${customers.loyaltyPointsBalance} + ${params.pointsDelta}`,
      lifetimePointsEarned: sql`${customers.lifetimePointsEarned} + ${lifetimeIncrement}`,
      updatedAt: new Date(),
    })
    .where(and(eq(customers.id, params.customerId), eq(customers.restaurantId, params.restaurantId)))
    .returning();

  if (!updatedCustomer) {
    // The customer didn't belong to this restaurant — defense in depth,
    // same reasoning as recordStockMovement's equivalent check. Throwing
    // here rolls back the whole transaction, including the ledger insert
    // above.
    throw new LoyaltyError("Customer not found for this restaurant.");
  }

  return { transaction, customer: updatedCustomer };
}

function todayIsoUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Awards the once-per-year birthday bonus, or does nothing if it's already
 * been claimed this year. The UPDATE's WHERE clause re-checks
 * lastBirthdayBonusYear (not just the caller's pre-check) as a
 * compare-and-swap — same pattern as the order status route's own
 * compare-and-swap on `orders.status` — so two concurrent callers (e.g. a
 * completed order and a CRM lookup landing the same moment) can't both
 * insert a ledger entry for the same birthday.
 *
 * Exported directly (not just via recordOrderCompletionLoyalty) because a
 * birthday bonus has to land even for a customer who never orders on their
 * exact birthday — see reconcileBirthdayBonus below.
 */
export async function awardBirthdayBonus(
  tx: Transaction,
  params: {
    restaurantId: string;
    customerId: string;
    todayIso: string;
    recordedByUserId?: string | null;
  },
) {
  const currentYear = Number(params.todayIso.slice(0, 4));

  const [claimed] = await tx
    .update(customers)
    .set({ lastBirthdayBonusYear: currentYear, updatedAt: new Date() })
    .where(
      and(
        eq(customers.id, params.customerId),
        eq(customers.restaurantId, params.restaurantId),
        or(isNull(customers.lastBirthdayBonusYear), ne(customers.lastBirthdayBonusYear, currentYear)),
      ),
    )
    .returning({ id: customers.id });

  if (!claimed) return null;

  return recordLoyaltyTransaction(tx, {
    restaurantId: params.restaurantId,
    customerId: params.customerId,
    type: "earn",
    pointsDelta: BIRTHDAY_BONUS_POINTS,
    referenceType: "birthday_bonus",
    referenceId: null,
    note: "Birthday bonus",
    recordedByUserId: params.recordedByUserId ?? null,
  });
}

/**
 * "Self-healing on read" birthday check — same pattern (and same reason:
 * no cron job, this app has no infrastructure for one) as
 * subscription-db.ts's reconcileSubscriptionStatus. Called from the
 * customers list/detail GET routes so a birthday bonus lands the moment
 * ANY staff surface looks that customer up on their birthday — CRM list,
 * CRM detail, or a POS customer search — not only if they happen to place
 * an order that exact day. Cheap no-op on every other call: one date
 * comparison, no write, when it's not their birthday or this year's bonus
 * is already claimed.
 */
export async function reconcileBirthdayBonus(
  tx: Transaction,
  customer: {
    id: string;
    restaurantId: string;
    dateOfBirth: string | null;
    lastBirthdayBonusYear: number | null;
  },
): Promise<boolean> {
  const todayIso = todayIsoUtc();
  if (
    !shouldAwardBirthdayBonus({
      dateOfBirth: customer.dateOfBirth,
      lastBirthdayBonusYear: customer.lastBirthdayBonusYear,
      todayIso,
    })
  ) {
    return false;
  }

  const awarded = await awardBirthdayBonus(tx, {
    restaurantId: customer.restaurantId,
    customerId: customer.id,
    todayIso,
    recordedByUserId: null,
  });
  return awarded !== null;
}

/**
 * Called exactly once per order — when an order transitions to
 * "completed" (see the order status route) AND has a linked customerId.
 * Awards points for the order total, updates the visit-streak counters,
 * awards a birthday bonus if today happens to be the customer's birthday,
 * and rolls the order into the customer's lifetime stats (total orders,
 * total spent) — all in the same transaction as the loyalty ledger
 * entries, so none of these numbers can drift apart. Idempotency for the
 * points/stats/streak update is free for the same reason recipe stock
 * deduction gets it for free in src/lib/inventory.ts: the order-status
 * state machine never allows a transition back to "completed" from a
 * later status (there is no later status), so this can only run once per
 * order. The birthday bonus has its own independent compare-and-swap (see
 * awardBirthdayBonus) since it's also reachable from a plain CRM lookup.
 *
 * Silently does nothing for points if the computed amount is 0 (an order
 * small enough that it rounds down to zero points still counts toward
 * totalOrdersCount/totalSpentInPaisa/the visit streak — those update
 * unconditionally, since "did they earn a point" and "did they visit" are
 * different questions).
 */
export async function recordOrderCompletionLoyalty(
  tx: Transaction,
  params: {
    restaurantId: string;
    customerId: string;
    orderId: string;
    totalInPaisa: number;
    recordedByUserId?: string | null;
  },
) {
  const [customer] = await tx
    .select({
      dateOfBirth: customers.dateOfBirth,
      lastBirthdayBonusYear: customers.lastBirthdayBonusYear,
      lastVisitDate: customers.lastVisitDate,
      currentVisitStreak: customers.currentVisitStreak,
      longestVisitStreak: customers.longestVisitStreak,
    })
    .from(customers)
    .where(and(eq(customers.id, params.customerId), eq(customers.restaurantId, params.restaurantId)))
    .limit(1);

  const todayIso = todayIsoUtc();
  const streak = customer
    ? computeVisitStreakUpdate({
        lastVisitDate: customer.lastVisitDate,
        currentStreak: customer.currentVisitStreak,
        longestStreak: customer.longestVisitStreak,
        todayIso,
      })
    : null;

  await tx
    .update(customers)
    .set({
      totalOrdersCount: sql`${customers.totalOrdersCount} + 1`,
      totalSpentInPaisa: sql`${customers.totalSpentInPaisa} + ${params.totalInPaisa}`,
      ...(streak
        ? {
            currentVisitStreak: streak.currentVisitStreak,
            longestVisitStreak: streak.longestVisitStreak,
            lastVisitDate: streak.lastVisitDate,
          }
        : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(customers.id, params.customerId), eq(customers.restaurantId, params.restaurantId)));

  if (streak?.milestoneReached) {
    await recordLoyaltyTransaction(tx, {
      restaurantId: params.restaurantId,
      customerId: params.customerId,
      type: "earn",
      pointsDelta: VISIT_STREAK_MILESTONE_POINTS,
      referenceType: "visit_streak",
      referenceId: params.orderId,
      note: `${streak.currentVisitStreak}-visit streak bonus`,
      recordedByUserId: params.recordedByUserId ?? null,
    });
  }

  if (
    customer &&
    shouldAwardBirthdayBonus({
      dateOfBirth: customer.dateOfBirth,
      lastBirthdayBonusYear: customer.lastBirthdayBonusYear,
      todayIso,
    })
  ) {
    await awardBirthdayBonus(tx, {
      restaurantId: params.restaurantId,
      customerId: params.customerId,
      todayIso,
      recordedByUserId: params.recordedByUserId ?? null,
    });
  }

  const points = computePointsEarned(params.totalInPaisa);
  if (points <= 0) return null;

  return recordLoyaltyTransaction(tx, {
    restaurantId: params.restaurantId,
    customerId: params.customerId,
    type: "earn",
    pointsDelta: points,
    referenceType: "order",
    referenceId: params.orderId,
    note: `Earned from order`,
    recordedByUserId: params.recordedByUserId ?? null,
  });
}
