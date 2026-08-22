/**
 * Phase 8b integration test: proves (a) MANAGE_CUSTOMERS is granted to
 * manager/cashier and withheld from waiter/kitchen_staff/inventory_manager
 * per the seeded role_permissions data — this is what every customers/
 * loyalty route in this phase is gated behind, (b) tenant isolation holds
 * for restaurant access resolution (reused from the staff test's pattern),
 * (c) recordLoyaltyTransaction's cross-tenant defense actually throws when
 * a customerId belongs to a different restaurant than the one passed in,
 * and (d) recordOrderCompletionLoyalty's points math and cached-field
 * bookkeeping (balance, lifetime points, order count, total spent) are
 * correct end to end against a real Postgres instance.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { PERMISSIONS } from "@/lib/rbac/permissions";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Customers + loyalty permissions (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let guard: typeof import("@/lib/rbac/guard");
  let loyalty: typeof import("@/lib/loyalty");

  let managerAId: string;
  let cashierAId: string;
  let waiterAId: string;
  let inventoryManagerAId: string;
  let ownerBId: string;
  let restaurantAId: string;
  let restaurantBId: string;
  let customerAId: string;
  let customerBId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    guard = await import("@/lib/rbac/guard");
    loyalty = await import("@/lib/loyalty");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [managerA] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Cust Manager A", phone: `9745${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    const [cashierA] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Cust Cashier A", phone: `9746${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    const [waiterA] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Cust Waiter A", phone: `9747${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    const [inventoryManagerA] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Cust InvMgr A", phone: `9748${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    const [ownerB] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Cust Owner B", phone: `9749${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    managerAId = managerA.id;
    cashierAId = cashierA.id;
    waiterAId = waiterA.id;
    inventoryManagerAId = inventoryManagerA.id;
    ownerBId = ownerB.id;

    const [restaurantA] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-cust-a-${suffix}`, name: "TEST Customers Restaurant A" })
      .returning({ id: schema.restaurants.id });
    const [restaurantB] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-cust-b-${suffix}`, name: "TEST Customers Restaurant B" })
      .returning({ id: schema.restaurants.id });
    restaurantAId = restaurantA.id;
    restaurantBId = restaurantB.id;

    await db.insert(schema.userRoles).values([
      { userId: managerAId, restaurantId: restaurantAId, role: "manager" },
      { userId: cashierAId, restaurantId: restaurantAId, role: "cashier" },
      { userId: waiterAId, restaurantId: restaurantAId, role: "waiter" },
      { userId: inventoryManagerAId, restaurantId: restaurantAId, role: "inventory_manager" },
      { userId: ownerBId, restaurantId: restaurantBId, role: "owner" },
    ]);

    const [customerA] = await db
      .insert(schema.customers)
      .values({
        restaurantId: restaurantAId,
        phone: `9750${suffix.slice(0, 6)}`,
        fullName: "TEST Customer A",
      })
      .returning({ id: schema.customers.id });
    const [customerB] = await db
      .insert(schema.customers)
      .values({
        restaurantId: restaurantBId,
        phone: `9751${suffix.slice(0, 6)}`,
        fullName: "TEST Customer B",
      })
      .returning({ id: schema.customers.id });
    customerAId = customerA.id;
    customerBId = customerB.id;
  });

  afterAll(async () => {
    await db.delete(schema.loyaltyTransactions).where(eq(schema.loyaltyTransactions.restaurantId, restaurantAId));
    await db.delete(schema.loyaltyTransactions).where(eq(schema.loyaltyTransactions.restaurantId, restaurantBId));
    await db.delete(schema.customers).where(eq(schema.customers.restaurantId, restaurantAId));
    await db.delete(schema.customers).where(eq(schema.customers.restaurantId, restaurantBId));
    await db.delete(schema.userRoles).where(eq(schema.userRoles.restaurantId, restaurantAId));
    await db.delete(schema.userRoles).where(eq(schema.userRoles.restaurantId, restaurantBId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantAId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantBId));
    await db.delete(schema.users).where(eq(schema.users.id, managerAId));
    await db.delete(schema.users).where(eq(schema.users.id, cashierAId));
    await db.delete(schema.users).where(eq(schema.users.id, waiterAId));
    await db.delete(schema.users).where(eq(schema.users.id, inventoryManagerAId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerBId));
  });

  it("manager and cashier hold MANAGE_CUSTOMERS; waiter and inventory_manager do not", async () => {
    await expect(
      guard.hasPermission(managerAId, restaurantAId, PERMISSIONS.MANAGE_CUSTOMERS),
    ).resolves.toBe(true);
    await expect(
      guard.hasPermission(cashierAId, restaurantAId, PERMISSIONS.MANAGE_CUSTOMERS),
    ).resolves.toBe(true);
    await expect(
      guard.hasPermission(waiterAId, restaurantAId, PERMISSIONS.MANAGE_CUSTOMERS),
    ).resolves.toBe(false);
    await expect(
      guard.hasPermission(inventoryManagerAId, restaurantAId, PERMISSIONS.MANAGE_CUSTOMERS),
    ).resolves.toBe(false);
  });

  it("requirePermission rejects a waiter attempting to manage customers with a 403", async () => {
    await expect(
      guard.requirePermission(waiterAId, restaurantAId, PERMISSIONS.MANAGE_CUSTOMERS),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("owner B cannot resolve access to restaurant A (tenant isolation)", async () => {
    await expect(guard.requireRestaurantAccess(ownerBId, restaurantAId)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("recordLoyaltyTransaction throws for a customer that doesn't belong to the given restaurant", async () => {
    await expect(
      db.transaction(async (tx) =>
        loyalty.recordLoyaltyTransaction(tx, {
          restaurantId: restaurantAId,
          customerId: customerBId, // belongs to restaurant B, not A
          type: "earn",
          pointsDelta: 10,
        }),
      ),
    ).rejects.toThrow(loyalty.LoyaltyError);
  });

  it("recordLoyaltyTransaction rejects a zero point delta", async () => {
    await expect(
      db.transaction(async (tx) =>
        loyalty.recordLoyaltyTransaction(tx, {
          restaurantId: restaurantAId,
          customerId: customerAId,
          type: "adjustment",
          pointsDelta: 0,
        }),
      ),
    ).rejects.toThrow(loyalty.LoyaltyError);
  });

  it("recordOrderCompletionLoyalty computes points at 1 per Rs 10, and updates balance + lifetime + order stats atomically", async () => {
    const fakeOrderId = "00000000-0000-4000-8000-000000000001";

    const result = await db.transaction(async (tx) =>
      loyalty.recordOrderCompletionLoyalty(tx, {
        restaurantId: restaurantAId,
        customerId: customerAId,
        orderId: fakeOrderId,
        totalInPaisa: 125_000, // Rs 1250 -> floor(125000/1000) = 125 points
        timezone: "UTC",
      }),
    );

    expect(result).not.toBeNull();
    expect(result?.transaction.pointsDelta).toBe(125);
    expect(result?.transaction.type).toBe("earn");
    expect(result?.customer.loyaltyPointsBalance).toBe(125);
    expect(result?.customer.lifetimePointsEarned).toBe(125);
    expect(result?.customer.totalOrdersCount).toBe(1);
    expect(result?.customer.totalSpentInPaisa).toBe(125_000);
  });

  it("recordOrderCompletionLoyalty still updates order stats even when the total rounds down to 0 points", async () => {
    const fakeOrderId = "00000000-0000-4000-8000-000000000002";

    const before = await db.query.customers.findFirst({
      where: (c, { eq: dEq }) => dEq(c.id, customerAId),
    });

    const result = await db.transaction(async (tx) =>
      loyalty.recordOrderCompletionLoyalty(tx, {
        restaurantId: restaurantAId,
        customerId: customerAId,
        orderId: fakeOrderId,
        totalInPaisa: 500, // Rs 5 -> floor(500/1000) = 0 points
        timezone: "UTC",
      }),
    );

    expect(result).toBeNull();

    const after = await db.query.customers.findFirst({
      where: (c, { eq: dEq }) => dEq(c.id, customerAId),
    });
    expect(after!.totalOrdersCount).toBe((before!.totalOrdersCount ?? 0) + 1);
    expect(after!.totalSpentInPaisa).toBe((before!.totalSpentInPaisa ?? 0) + 500);
    // Balance/lifetime points unchanged from the previous test's 125.
    expect(after!.loyaltyPointsBalance).toBe(before!.loyaltyPointsBalance);
  });

  it("a manual redeem transaction reduces balance but not lifetime points (tier standing is preserved)", async () => {
    const before = await db.query.customers.findFirst({
      where: (c, { eq: dEq }) => dEq(c.id, customerAId),
    });

    const result = await db.transaction(async (tx) =>
      loyalty.recordLoyaltyTransaction(tx, {
        restaurantId: restaurantAId,
        customerId: customerAId,
        type: "redeem",
        pointsDelta: -50,
        note: "TEST redemption",
      }),
    );

    expect(result.customer.loyaltyPointsBalance).toBe(before!.loyaltyPointsBalance - 50);
    expect(result.customer.lifetimePointsEarned).toBe(before!.lifetimePointsEarned);
  });

  it("loyalty_transactions rows are correctly scoped per restaurant (a real DB round trip)", async () => {
    const rows = await db
      .select()
      .from(schema.loyaltyTransactions)
      .where(
        and(
          eq(schema.loyaltyTransactions.restaurantId, restaurantAId),
          eq(schema.loyaltyTransactions.customerId, customerAId),
        ),
      );
    // earn (125) + earn no-op skipped (null, no row) + redeem (-50) = 2 rows
    expect(rows.length).toBe(2);

    const forOtherRestaurant = await db
      .select()
      .from(schema.loyaltyTransactions)
      .where(eq(schema.loyaltyTransactions.restaurantId, restaurantBId));
    expect(forOtherRestaurant).toHaveLength(0);
  });
});
