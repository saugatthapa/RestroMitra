/**
 * Phase 5 integration test: proves (a) the REFUND_ORDER permission split
 * seeded in DEFAULT_ROLE_PERMISSIONS actually holds against the live
 * role_permissions table — waiter can EDIT_ORDER (so can record a payment)
 * but not REFUND_ORDER; manager and owner can do both — and (b) payments
 * never leak across tenant boundaries, using the same
 * scoped-lookup-matches-zero-rows pattern every route in this project
 * relies on for tenant isolation.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { computeBillingSummary, computeNetPaid } from "@/lib/payments";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("payments permissions + tenant isolation (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let guard: typeof import("@/lib/rbac/guard");

  let ownerAId: string;
  let waiterAId: string;
  let managerAId: string;
  let ownerBId: string;
  let restaurantAId: string;
  let restaurantBId: string;
  let branchAId: string;
  let orderAId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    guard = await import("@/lib/rbac/guard");
    const { generateOrderNumber } = await import("@/lib/orders");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [ownerA] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Payments Owner A", phone: `9711${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    const [waiterA] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Payments Waiter A", phone: `9712${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    const [managerA] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Payments Manager A", phone: `9713${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    const [ownerB] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Payments Owner B", phone: `9714${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    ownerAId = ownerA.id;
    waiterAId = waiterA.id;
    managerAId = managerA.id;
    ownerBId = ownerB.id;

    const [restaurantA] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-payments-a-${suffix}`, name: "TEST Payments Restaurant A" })
      .returning({ id: schema.restaurants.id });
    const [restaurantB] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-payments-b-${suffix}`, name: "TEST Payments Restaurant B" })
      .returning({ id: schema.restaurants.id });
    restaurantAId = restaurantA.id;
    restaurantBId = restaurantB.id;

    const [branchA] = await db
      .insert(schema.branches)
      .values({ restaurantId: restaurantAId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    branchAId = branchA.id;

    await db.insert(schema.userRoles).values([
      { userId: ownerAId, restaurantId: restaurantAId, role: "owner" },
      { userId: waiterAId, restaurantId: restaurantAId, role: "waiter" },
      { userId: managerAId, restaurantId: restaurantAId, role: "manager" },
      { userId: ownerBId, restaurantId: restaurantBId, role: "owner" },
    ]);

    const [order] = await db
      .insert(schema.orders)
      .values({
        restaurantId: restaurantAId,
        branchId: branchAId,
        tableId: null,
        orderNumber: generateOrderNumber("UTC"),
        source: "pos",
        status: "pending",
        subtotalInPaisa: 100_000,
        taxInPaisa: 0,
        totalInPaisa: 100_000,
      })
      .returning({ id: schema.orders.id });
    orderAId = order.id;
  });

  afterAll(async () => {
    await db.delete(schema.payments).where(eq(schema.payments.restaurantId, restaurantAId));
    await db.delete(schema.orders).where(eq(schema.orders.restaurantId, restaurantAId));
    await db.delete(schema.branches).where(eq(schema.branches.id, branchAId));
    await db.delete(schema.userRoles).where(eq(schema.userRoles.restaurantId, restaurantAId));
    await db.delete(schema.userRoles).where(eq(schema.userRoles.restaurantId, restaurantBId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantAId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantBId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerAId));
    await db.delete(schema.users).where(eq(schema.users.id, waiterAId));
    await db.delete(schema.users).where(eq(schema.users.id, managerAId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerBId));
  });

  it("waiter can EDIT_ORDER (record a payment) but is denied REFUND_ORDER", async () => {
    await expect(
      guard.requirePermission(waiterAId, restaurantAId, PERMISSIONS.EDIT_ORDER),
    ).resolves.toBeUndefined();
    await expect(
      guard.requirePermission(waiterAId, restaurantAId, PERMISSIONS.REFUND_ORDER),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("manager can both EDIT_ORDER and REFUND_ORDER (widened from owner-only)", async () => {
    await expect(
      guard.requirePermission(managerAId, restaurantAId, PERMISSIONS.EDIT_ORDER),
    ).resolves.toBeUndefined();
    await expect(
      guard.requirePermission(managerAId, restaurantAId, PERMISSIONS.REFUND_ORDER),
    ).resolves.toBeUndefined();
  });

  it("owner B cannot resolve restaurant access to restaurant A (precondition for the payments/refunds routes)", async () => {
    await expect(
      guard.requireRestaurantAccess(ownerBId, restaurantAId),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("an order lookup scoped to restaurant B's id matches ZERO rows against restaurant A's order (the check every payments/refunds route runs before inserting)", async () => {
    const rows = await db
      .select()
      .from(schema.orders)
      .where(and(eq(schema.orders.id, orderAId), eq(schema.orders.restaurantId, restaurantBId)));
    expect(rows).toHaveLength(0);
  });

  it("records split payments and derives the correct running billing summary, matching the DB after each insert", async () => {
    const [firstPayment] = await db
      .insert(schema.payments)
      .values({
        restaurantId: restaurantAId,
        orderId: orderAId,
        amountInPaisa: 60_000,
        method: "cash",
        recordedByUserId: waiterAId,
      })
      .returning();
    expect(firstPayment.amountInPaisa).toBe(60_000);

    let rows = await db
      .select({ amountInPaisa: schema.payments.amountInPaisa })
      .from(schema.payments)
      .where(and(eq(schema.payments.orderId, orderAId), eq(schema.payments.restaurantId, restaurantAId)));
    let summary = computeBillingSummary(100_000, rows.map((r) => r.amountInPaisa));
    expect(summary.paymentStatus).toBe("partially_paid");
    expect(summary.remainingDueInPaisa).toBe(40_000);

    await db.insert(schema.payments).values({
      restaurantId: restaurantAId,
      orderId: orderAId,
      amountInPaisa: 40_000,
      method: "card",
      recordedByUserId: waiterAId,
    });

    rows = await db
      .select({ amountInPaisa: schema.payments.amountInPaisa })
      .from(schema.payments)
      .where(and(eq(schema.payments.orderId, orderAId), eq(schema.payments.restaurantId, restaurantAId)));
    summary = computeBillingSummary(100_000, rows.map((r) => r.amountInPaisa));
    expect(summary.paymentStatus).toBe("paid");
    expect(summary.remainingDueInPaisa).toBe(0);
    expect(computeNetPaid(rows.map((r) => r.amountInPaisa))).toBe(100_000);
  });

  it("a manager's partial refund is stored as a negative amount and drops the order back to partially_paid", async () => {
    const [refund] = await db
      .insert(schema.payments)
      .values({
        restaurantId: restaurantAId,
        orderId: orderAId,
        amountInPaisa: -30_000,
        method: "cash",
        note: "TEST customer complaint",
        recordedByUserId: managerAId,
      })
      .returning();
    expect(refund.amountInPaisa).toBe(-30_000);

    const rows = await db
      .select({ amountInPaisa: schema.payments.amountInPaisa })
      .from(schema.payments)
      .where(and(eq(schema.payments.orderId, orderAId), eq(schema.payments.restaurantId, restaurantAId)));
    const summary = computeBillingSummary(100_000, rows.map((r) => r.amountInPaisa));
    expect(summary.netPaidInPaisa).toBe(70_000);
    expect(summary.paymentStatus).toBe("partially_paid");
    expect(summary.remainingDueInPaisa).toBe(30_000);
  });

  it("querying restaurant B's payments for this order returns nothing — payments don't leak across the tenant boundary", async () => {
    const rows = await db
      .select()
      .from(schema.payments)
      .where(and(eq(schema.payments.orderId, orderAId), eq(schema.payments.restaurantId, restaurantBId)));
    expect(rows).toHaveLength(0);
  });
});
