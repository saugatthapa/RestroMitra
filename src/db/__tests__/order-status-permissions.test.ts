/**
 * Phase 4 integration test: proves (a) orders never leak across tenant
 * boundaries — the same update-scoped-to-wrong-restaurant-matches-zero-rows
 * pattern every PATCH route in this project relies on — and (b) the
 * cancel-vs-edit permission split the status route enforces actually
 * matches the seeded role_permissions data: waiter/cashier can EDIT_ORDER
 * but not CANCEL_ORDER, manager/owner can do both.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { PERMISSIONS } from "@/lib/rbac/permissions";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("order status permissions + tenant isolation (integration)", () => {
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
    const { generateQrToken } = await import("@/lib/qr");
    const { generateOrderNumber } = await import("@/lib/orders");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [ownerA] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Orders Owner A", phone: `9707${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    const [waiterA] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Orders Waiter A", phone: `9708${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    const [managerA] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Orders Manager A", phone: `9709${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    const [ownerB] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Orders Owner B", phone: `9710${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    ownerAId = ownerA.id;
    waiterAId = waiterA.id;
    managerAId = managerA.id;
    ownerBId = ownerB.id;

    const [restaurantA] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-orders-a-${suffix}`, name: "TEST Orders Restaurant A" })
      .returning({ id: schema.restaurants.id });
    const [restaurantB] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-orders-b-${suffix}`, name: "TEST Orders Restaurant B" })
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

    const [table] = await db
      .insert(schema.restaurantTables)
      .values({ restaurantId: restaurantAId, branchId: branchAId, name: "TEST Table", qrToken: generateQrToken() })
      .returning({ id: schema.restaurantTables.id });

    const [order] = await db
      .insert(schema.orders)
      .values({
        restaurantId: restaurantAId,
        branchId: branchAId,
        tableId: table.id,
        orderNumber: generateOrderNumber(),
        source: "qr_customer",
        status: "pending",
        subtotalInPaisa: 10_000,
        taxInPaisa: 0,
        totalInPaisa: 10_000,
      })
      .returning({ id: schema.orders.id });
    orderAId = order.id;
  });

  afterAll(async () => {
    await db.delete(schema.orders).where(eq(schema.orders.restaurantId, restaurantAId));
    await db.delete(schema.restaurantTables).where(eq(schema.restaurantTables.restaurantId, restaurantAId));
    await db.delete(schema.branches).where(eq(schema.branches.id, branchAId));
    await db.delete(schema.userRoles).where(eq(schema.userRoles.restaurantId, restaurantAId));
    await db.delete(schema.userRoles).where(eq(schema.userRoles.restaurantId, restaurantBId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantAId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantBId));
    await db
      .delete(schema.users)
      .where(eq(schema.users.id, ownerAId));
    await db.delete(schema.users).where(eq(schema.users.id, waiterAId));
    await db.delete(schema.users).where(eq(schema.users.id, managerAId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerBId));
  });

  it("waiter can EDIT_ORDER but is denied CANCEL_ORDER", async () => {
    await expect(
      guard.requirePermission(waiterAId, restaurantAId, PERMISSIONS.EDIT_ORDER),
    ).resolves.toBeUndefined();
    await expect(
      guard.requirePermission(waiterAId, restaurantAId, PERMISSIONS.CANCEL_ORDER),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("manager can both EDIT_ORDER and CANCEL_ORDER", async () => {
    await expect(
      guard.requirePermission(managerAId, restaurantAId, PERMISSIONS.EDIT_ORDER),
    ).resolves.toBeUndefined();
    await expect(
      guard.requirePermission(managerAId, restaurantAId, PERMISSIONS.CANCEL_ORDER),
    ).resolves.toBeUndefined();
  });

  it("owner B cannot resolve restaurant access to restaurant A (precondition for the status route)", async () => {
    await expect(
      guard.requireRestaurantAccess(ownerBId, restaurantAId),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("an update scoped to restaurant B's id matches ZERO rows against restaurant A's order", async () => {
    const updated = await db
      .update(schema.orders)
      .set({ status: "cancelled" })
      .where(and(eq(schema.orders.id, orderAId), eq(schema.orders.restaurantId, restaurantBId)))
      .returning();
    expect(updated).toHaveLength(0);

    const [stillPending] = await db.select().from(schema.orders).where(eq(schema.orders.id, orderAId));
    expect(stillPending.status).toBe("pending");
  });

  it("a correctly-scoped update to restaurant A's own order succeeds", async () => {
    const updated = await db
      .update(schema.orders)
      .set({ status: "confirmed" })
      .where(and(eq(schema.orders.id, orderAId), eq(schema.orders.restaurantId, restaurantAId)))
      .returning();
    expect(updated).toHaveLength(1);
    expect(updated[0].status).toBe("confirmed");
  });
});
