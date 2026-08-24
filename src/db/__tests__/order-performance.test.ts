/**
 * Commercial-launch Phase B.1 (Order Status History + Order Performance
 * reporting) integration tests for:
 *  - src/lib/order-status-history.ts (recordOrderStatusHistory)
 *  - src/lib/reports.ts's getOrderPerformanceStats
 *
 * Fixture orders/history rows are inserted directly with explicit
 * placedAt/changedAt timestamps (same convention as cogs-reporting.test.ts)
 * so stage-duration averages are exact, hand-computed values rather than
 * timing-dependent. Kept as its own file/fixture for the same reason
 * cogs-reporting.test.ts is separate from reports-permissions.test.ts — a
 * shared-fixture order inside another file's date range would silently
 * perturb its hand-computed totals.
 *
 * Skipped (not failed) when DATABASE_URL isn't set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Order status history + performance (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let reports: typeof import("@/lib/reports");
  let osh: typeof import("@/lib/order-status-history");

  let restaurantId: string;
  let otherRestaurantId: string;
  let branchId: string;
  let branchBId: string;
  let userId: string;
  let generateOrderNumber: (timezone: string) => string;

  const RANGE = { from: "2026-07-01", to: "2026-07-07" };
  const TZ = "UTC";

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    reports = await import("@/lib/reports");
    osh = await import("@/lib/order-status-history");
    ({ generateOrderNumber } = await import("@/lib/orders"));

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-order-perf-${suffix}`, name: "TEST Order Performance Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [otherRestaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-order-perf-other-${suffix}`, name: "TEST Other Restaurant" })
      .returning({ id: schema.restaurants.id });
    otherRestaurantId = otherRestaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;

    const [branchB] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Branch B", isMain: false })
      .returning({ id: schema.branches.id });
    branchBId = branchB.id;

    const [user] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Order Perf User", phone: `976${suffix}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    userId = user.id;
  });

  afterAll(async () => {
    await db.delete(schema.orderStatusHistory).where(eq(schema.orderStatusHistory.restaurantId, restaurantId));
    await db.delete(schema.orders).where(eq(schema.orders.restaurantId, restaurantId));
    await db.delete(schema.orderStatusHistory).where(eq(schema.orderStatusHistory.restaurantId, otherRestaurantId));
    await db.delete(schema.orders).where(eq(schema.orders.restaurantId, otherRestaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, otherRestaurantId));
  });

  async function createOrder(params: { targetRestaurantId: string; targetBranchId: string; placedAt: Date; status?: string }) {
    const [order] = await db
      .insert(schema.orders)
      .values({
        restaurantId: params.targetRestaurantId,
        branchId: params.targetBranchId,
        orderNumber: generateOrderNumber(TZ),
        source: "pos",
        status: (params.status ?? "pending") as typeof schema.orders.$inferInsert.status,
        subtotalInPaisa: 10_000,
        taxInPaisa: 0,
        totalInPaisa: 10_000,
        placedAt: params.placedAt,
      })
      .returning({ id: schema.orders.id });
    return order.id;
  }

  async function insertHistory(
    orderId: string,
    targetRestaurantId: string,
    fromStatus: string,
    toStatus: string,
    changedAt: Date,
    reason?: string | null,
  ) {
    await db.insert(schema.orderStatusHistory).values({
      restaurantId: targetRestaurantId,
      orderId,
      fromStatus: fromStatus as typeof schema.orderStatusHistory.$inferInsert.fromStatus,
      toStatus: toStatus as typeof schema.orderStatusHistory.$inferInsert.toStatus,
      changedByUserId: userId,
      reason: reason ?? null,
      changedAt,
    });
  }

  it("recordOrderStatusHistory writes a row with the given fields", async () => {
    // placedAt deliberately OUTSIDE every other test's date range in this
    // file, so this fixture order's history row (with a real defaultNow()
    // changedAt, not a hand-picked one) can never be picked up by a later
    // stats query and skew its hand-computed averages.
    const orderId = await createOrder({ targetRestaurantId: restaurantId, targetBranchId: branchId, placedAt: new Date("2026-01-01T00:00:00Z") });
    const row = await db.transaction((tx) =>
      osh.recordOrderStatusHistory(tx, {
        restaurantId,
        orderId,
        fromStatus: "pending",
        toStatus: "confirmed",
        changedByUserId: userId,
        reason: null,
      }),
    );
    expect(row.orderId).toBe(orderId);
    expect(row.fromStatus).toBe("pending");
    expect(row.toStatus).toBe("confirmed");
    expect(row.changedByUserId).toBe(userId);
  });

  it("happy path: full lifecycle produces exact hand-computed stage durations", async () => {
    const placedAt = new Date("2026-07-03T10:00:00Z");
    const orderId = await createOrder({ targetRestaurantId: restaurantId, targetBranchId: branchId, placedAt, status: "completed" });

    // pending->confirmed: 2 min. confirmed->preparing: 3 min.
    // preparing->ready: 12 min. ready->served: 4 min. served->completed: 15 min.
    await insertHistory(orderId, restaurantId, "pending", "confirmed", new Date("2026-07-03T10:02:00Z"));
    await insertHistory(orderId, restaurantId, "confirmed", "preparing", new Date("2026-07-03T10:05:00Z"));
    await insertHistory(orderId, restaurantId, "preparing", "ready", new Date("2026-07-03T10:17:00Z"));
    await insertHistory(orderId, restaurantId, "ready", "served", new Date("2026-07-03T10:21:00Z"));
    await insertHistory(orderId, restaurantId, "served", "completed", new Date("2026-07-03T10:36:00Z"));

    const stats = await reports.getOrderPerformanceStats(restaurantId, RANGE, TZ, branchId);
    const byPair = Object.fromEntries(stats.stageDurations.map((s) => [`${s.fromStatus}->${s.toStatus}`, s]));

    expect(byPair["pending->confirmed"]).toMatchObject({ avgMinutes: 2, transitionCount: 1 });
    expect(byPair["confirmed->preparing"]).toMatchObject({ avgMinutes: 3, transitionCount: 1 });
    expect(byPair["preparing->ready"]).toMatchObject({ avgMinutes: 12, transitionCount: 1 });
    expect(byPair["ready->served"]).toMatchObject({ avgMinutes: 4, transitionCount: 1 });
    expect(byPair["served->completed"]).toMatchObject({ avgMinutes: 15, transitionCount: 1 });
  });

  it("averages correctly across two orders in the same stage", async () => {
    const placedAtA = new Date("2026-07-04T09:00:00Z");
    const orderA = await createOrder({ targetRestaurantId: restaurantId, targetBranchId: branchId, placedAt: placedAtA });
    await insertHistory(orderA, restaurantId, "pending", "confirmed", new Date("2026-07-04T09:04:00Z")); // 4 min

    const placedAtB = new Date("2026-07-04T11:00:00Z");
    const orderB = await createOrder({ targetRestaurantId: restaurantId, targetBranchId: branchId, placedAt: placedAtB });
    await insertHistory(orderB, restaurantId, "pending", "confirmed", new Date("2026-07-04T11:02:00Z")); // 2 min

    const stats = await reports.getOrderPerformanceStats(restaurantId, { from: "2026-07-04", to: "2026-07-04" }, TZ, branchId);
    const pendingToConfirmed = stats.stageDurations.find((s) => s.fromStatus === "pending" && s.toStatus === "confirmed")!;
    expect(pendingToConfirmed.avgMinutes).toBe(3); // (4+2)/2
    expect(pendingToConfirmed.transitionCount).toBe(2);
  });

  it("cancellation stats: rate, average time before cancellation, and reason breakdown", async () => {
    const range = { from: "2026-07-05", to: "2026-07-05" };

    const cancelledA = await createOrder({ targetRestaurantId: restaurantId, targetBranchId: branchId, placedAt: new Date("2026-07-05T12:00:00Z"), status: "cancelled" });
    await insertHistory(cancelledA, restaurantId, "pending", "cancelled", new Date("2026-07-05T12:03:00Z"), "Customer changed mind");

    const cancelledB = await createOrder({ targetRestaurantId: restaurantId, targetBranchId: branchId, placedAt: new Date("2026-07-05T13:00:00Z"), status: "cancelled" });
    await insertHistory(cancelledB, restaurantId, "confirmed", "cancelled", new Date("2026-07-05T13:07:00Z"), null);

    const completed = await createOrder({ targetRestaurantId: restaurantId, targetBranchId: branchId, placedAt: new Date("2026-07-05T14:00:00Z"), status: "completed" });
    await insertHistory(completed, restaurantId, "pending", "confirmed", new Date("2026-07-05T14:01:00Z"));

    const stats = await reports.getOrderPerformanceStats(restaurantId, range, TZ, branchId);
    expect(stats.cancelledCount).toBe(2);
    expect(stats.cancellationRatePercent).toBeCloseTo((2 / 3) * 100, 1);
    expect(stats.avgMinutesBeforeCancellation).toBe(5); // (3+7)/2
    const reasonMap = Object.fromEntries(stats.cancellationReasons.map((r) => [r.reason, r.count]));
    expect(reasonMap["Customer changed mind"]).toBe(1);
    expect(reasonMap["No reason given"]).toBe(1);
  });

  it("wrong-branch: a branch-scoped query never counts another branch's transitions", async () => {
    const orderInB = await createOrder({ targetRestaurantId: restaurantId, targetBranchId: branchBId, placedAt: new Date("2026-07-06T10:00:00Z") });
    await insertHistory(orderInB, restaurantId, "pending", "confirmed", new Date("2026-07-06T10:09:00Z"));

    const range = { from: "2026-07-06", to: "2026-07-06" };
    const branchAStats = await reports.getOrderPerformanceStats(restaurantId, range, TZ, branchId);
    const branchAPending = branchAStats.stageDurations.find((s) => s.fromStatus === "pending" && s.toStatus === "confirmed")!;
    expect(branchAPending.transitionCount).toBe(0);
    expect(branchAPending.avgMinutes).toBeNull();

    const branchBStats = await reports.getOrderPerformanceStats(restaurantId, range, TZ, branchBId);
    const branchBPending = branchBStats.stageDurations.find((s) => s.fromStatus === "pending" && s.toStatus === "confirmed")!;
    expect(branchBPending.transitionCount).toBe(1);
    expect(branchBPending.avgMinutes).toBe(9);
  });

  it("wrong-restaurant isolation: another restaurant's history never leaks into this restaurant's stats", async () => {
    const [otherBranch] = await db
      .insert(schema.branches)
      .values({ restaurantId: otherRestaurantId, name: "Other Main", isMain: true })
      .returning({ id: schema.branches.id });

    const otherOrder = await createOrder({ targetRestaurantId: otherRestaurantId, targetBranchId: otherBranch.id, placedAt: new Date("2026-07-06T10:00:00Z") });
    await insertHistory(otherOrder, otherRestaurantId, "pending", "confirmed", new Date("2026-07-06T10:20:00Z"));

    const range = { from: "2026-07-06", to: "2026-07-06" };
    const ownStats = await reports.getOrderPerformanceStats(restaurantId, range, TZ);
    const pending = ownStats.stageDurations.find((s) => s.fromStatus === "pending" && s.toStatus === "confirmed")!;
    // Only the wrong-branch test's branch-B row (9 min) should land in this
    // restaurant's unscoped stats for this date — if the other restaurant's
    // 20-min transition leaked in, the average/count would both be wrong.
    expect(pending.transitionCount).toBe(1);
    expect(pending.avgMinutes).toBe(9);
  });

  it("edge case: zero orders/transitions in range returns null averages and zero counts, no crash", async () => {
    const stats = await reports.getOrderPerformanceStats(restaurantId, { from: "2020-01-01", to: "2020-01-01" }, TZ, branchId);
    for (const s of stats.stageDurations) {
      expect(s.avgMinutes).toBeNull();
      expect(s.transitionCount).toBe(0);
    }
    expect(stats.cancelledCount).toBe(0);
    expect(stats.cancellationRatePercent).toBe(0);
    expect(stats.avgMinutesBeforeCancellation).toBeNull();
    expect(stats.cancellationReasons).toHaveLength(0);
  });
});
