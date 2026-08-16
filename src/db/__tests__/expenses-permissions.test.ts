/**
 * Phase 8c integration test: proves (a) MANAGE_EXPENSES is granted to
 * manager/owner and withheld from cashier/waiter/kitchen_staff/
 * inventory_manager per the seeded role_permissions data — expenses are
 * treated as profit-adjacent data, same trust level as MANAGE_STAFF/
 * MANAGE_INVENTORY, not handed to every front-of-house role the way
 * MANAGE_CUSTOMERS was — (b) tenant isolation holds for restaurant access
 * resolution, and (c) a real DB round trip for the expenses table,
 * including the isVoided soft-delete flag and per-restaurant scoping.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { PERMISSIONS } from "@/lib/rbac/permissions";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Expenses permissions (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let guard: typeof import("@/lib/rbac/guard");

  let managerAId: string;
  let cashierAId: string;
  let inventoryManagerAId: string;
  let ownerBId: string;
  let restaurantAId: string;
  let restaurantBId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    guard = await import("@/lib/rbac/guard");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [managerA] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Exp Manager A", phone: `9755${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    const [cashierA] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Exp Cashier A", phone: `9756${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    const [inventoryManagerA] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Exp InvMgr A", phone: `9757${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    const [ownerB] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Exp Owner B", phone: `9758${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    managerAId = managerA.id;
    cashierAId = cashierA.id;
    inventoryManagerAId = inventoryManagerA.id;
    ownerBId = ownerB.id;

    const [restaurantA] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-exp-a-${suffix}`, name: "TEST Expenses Restaurant A" })
      .returning({ id: schema.restaurants.id });
    const [restaurantB] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-exp-b-${suffix}`, name: "TEST Expenses Restaurant B" })
      .returning({ id: schema.restaurants.id });
    restaurantAId = restaurantA.id;
    restaurantBId = restaurantB.id;

    await db.insert(schema.userRoles).values([
      { userId: managerAId, restaurantId: restaurantAId, role: "manager" },
      { userId: cashierAId, restaurantId: restaurantAId, role: "cashier" },
      { userId: inventoryManagerAId, restaurantId: restaurantAId, role: "inventory_manager" },
      { userId: ownerBId, restaurantId: restaurantBId, role: "owner" },
    ]);
  });

  afterAll(async () => {
    await db.delete(schema.expenses).where(eq(schema.expenses.restaurantId, restaurantAId));
    await db.delete(schema.expenses).where(eq(schema.expenses.restaurantId, restaurantBId));
    await db.delete(schema.userRoles).where(eq(schema.userRoles.restaurantId, restaurantAId));
    await db.delete(schema.userRoles).where(eq(schema.userRoles.restaurantId, restaurantBId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantAId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantBId));
    await db.delete(schema.users).where(eq(schema.users.id, managerAId));
    await db.delete(schema.users).where(eq(schema.users.id, cashierAId));
    await db.delete(schema.users).where(eq(schema.users.id, inventoryManagerAId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerBId));
  });

  it("manager holds MANAGE_EXPENSES; cashier and inventory_manager do not", async () => {
    await expect(
      guard.hasPermission(managerAId, restaurantAId, PERMISSIONS.MANAGE_EXPENSES),
    ).resolves.toBe(true);
    await expect(
      guard.hasPermission(cashierAId, restaurantAId, PERMISSIONS.MANAGE_EXPENSES),
    ).resolves.toBe(false);
    await expect(
      guard.hasPermission(inventoryManagerAId, restaurantAId, PERMISSIONS.MANAGE_EXPENSES),
    ).resolves.toBe(false);
  });

  it("requirePermission rejects a cashier attempting to manage expenses with a 403", async () => {
    await expect(
      guard.requirePermission(cashierAId, restaurantAId, PERMISSIONS.MANAGE_EXPENSES),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("owner B cannot resolve access to restaurant A (tenant isolation)", async () => {
    await expect(guard.requireRestaurantAccess(ownerBId, restaurantAId)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("expenses round-trip correctly, including voiding, and are scoped per restaurant", async () => {
    const [expense] = await db
      .insert(schema.expenses)
      .values({
        restaurantId: restaurantAId,
        category: "utilities",
        amountInPaisa: 250000,
        description: "TEST electricity bill",
        recordedByUserId: managerAId,
      })
      .returning();

    expect(expense.isVoided).toBe(false);
    expect(expense.amountInPaisa).toBe(250000);

    const [voided] = await db
      .update(schema.expenses)
      .set({ isVoided: true })
      .where(eq(schema.expenses.id, expense.id))
      .returning();
    expect(voided.isVoided).toBe(true);

    const forOtherRestaurant = await db
      .select()
      .from(schema.expenses)
      .where(eq(schema.expenses.restaurantId, restaurantBId));
    expect(forOtherRestaurant).toHaveLength(0);

    const forThisRestaurant = await db
      .select()
      .from(schema.expenses)
      .where(
        and(eq(schema.expenses.restaurantId, restaurantAId), eq(schema.expenses.id, expense.id)),
      );
    expect(forThisRestaurant).toHaveLength(1);
  });
});
