/**
 * Phase 6 integration test: proves (a) requireAnyPermission grants access
 * when the caller holds ANY of the listed permissions and fails closed
 * otherwise (including the "empty permissions list" edge case, which must
 * never be trivially satisfied), (b) the kitchen_staff-vs-waiter split the
 * status route relies on actually matches the seeded role_permissions data
 * — kitchen_staff has UPDATE_KDS_STATUS but not EDIT_ORDER, waiter is the
 * mirror image — and (c) a menu item's kitchen station is correctly
 * snapshotted onto order_items at order-creation time and survives a real
 * DB round trip.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { PERMISSIONS } from "@/lib/rbac/permissions";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("KDS permissions + kitchen station snapshot (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let guard: typeof import("@/lib/rbac/guard");

  let ownerAId: string;
  let kitchenStaffAId: string;
  let waiterAId: string;
  let ownerBId: string;
  let restaurantAId: string;
  let restaurantBId: string;
  let branchAId: string;
  let categoryId: string;
  let grillStationId: string;
  let barStationId: string;
  let grillItemId: string;
  let barItemId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    guard = await import("@/lib/rbac/guard");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [ownerA] = await db
      .insert(schema.users)
      .values({ fullName: "TEST KDS Owner A", phone: `9715${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    const [kitchenStaffA] = await db
      .insert(schema.users)
      .values({ fullName: "TEST KDS Kitchen A", phone: `9716${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    const [waiterA] = await db
      .insert(schema.users)
      .values({ fullName: "TEST KDS Waiter A", phone: `9717${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    const [ownerB] = await db
      .insert(schema.users)
      .values({ fullName: "TEST KDS Owner B", phone: `9718${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    ownerAId = ownerA.id;
    kitchenStaffAId = kitchenStaffA.id;
    waiterAId = waiterA.id;
    ownerBId = ownerB.id;

    const [restaurantA] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-kds-a-${suffix}`, name: "TEST KDS Restaurant A" })
      .returning({ id: schema.restaurants.id });
    const [restaurantB] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-kds-b-${suffix}`, name: "TEST KDS Restaurant B" })
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
      { userId: kitchenStaffAId, restaurantId: restaurantAId, role: "kitchen_staff" },
      { userId: waiterAId, restaurantId: restaurantAId, role: "waiter" },
      { userId: ownerBId, restaurantId: restaurantBId, role: "owner" },
    ]);

    const [category] = await db
      .insert(schema.categories)
      .values({ restaurantId: restaurantAId, name: "TEST Category" })
      .returning({ id: schema.categories.id });
    categoryId = category.id;

    const [grillStation] = await db
      .insert(schema.kitchenStations)
      .values({ restaurantId: restaurantAId, name: "TEST Grill" })
      .returning({ id: schema.kitchenStations.id });
    const [barStation] = await db
      .insert(schema.kitchenStations)
      .values({ restaurantId: restaurantAId, name: "TEST Bar" })
      .returning({ id: schema.kitchenStations.id });
    grillStationId = grillStation.id;
    barStationId = barStation.id;

    const [grillItem] = await db
      .insert(schema.menuItems)
      .values({
        restaurantId: restaurantAId,
        categoryId,
        kitchenStationId: grillStationId,
        name: "TEST Sizzler",
        basePriceInPaisa: 30_000,
      })
      .returning({ id: schema.menuItems.id });
    const [barItem] = await db
      .insert(schema.menuItems)
      .values({
        restaurantId: restaurantAId,
        categoryId,
        kitchenStationId: barStationId,
        name: "TEST Lassi",
        basePriceInPaisa: 12_000,
      })
      .returning({ id: schema.menuItems.id });
    grillItemId = grillItem.id;
    barItemId = barItem.id;
  });

  afterAll(async () => {
    // order_items cascade-deletes with their parent order (onDelete:
    // "cascade" in schema.ts), so deleting orders is sufficient here — this
    // is just a safety net in case the last test failed before reaching
    // its own inline cleanup.
    await db.delete(schema.orders).where(eq(schema.orders.restaurantId, restaurantAId));
    await db.delete(schema.menuItems).where(eq(schema.menuItems.restaurantId, restaurantAId));
    await db.delete(schema.kitchenStations).where(eq(schema.kitchenStations.restaurantId, restaurantAId));
    await db.delete(schema.categories).where(eq(schema.categories.restaurantId, restaurantAId));
    await db.delete(schema.branches).where(eq(schema.branches.id, branchAId));
    await db.delete(schema.userRoles).where(eq(schema.userRoles.restaurantId, restaurantAId));
    await db.delete(schema.userRoles).where(eq(schema.userRoles.restaurantId, restaurantBId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantAId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantBId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerAId));
    await db.delete(schema.users).where(eq(schema.users.id, kitchenStaffAId));
    await db.delete(schema.users).where(eq(schema.users.id, waiterAId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerBId));
  });

  it("kitchen_staff satisfies [EDIT_ORDER, UPDATE_KDS_STATUS] via the narrower permission alone", async () => {
    await expect(
      guard.requireAnyPermission(kitchenStaffAId, restaurantAId, [
        PERMISSIONS.EDIT_ORDER,
        PERMISSIONS.UPDATE_KDS_STATUS,
      ]),
    ).resolves.toBeUndefined();
  });

  it("kitchen_staff does NOT satisfy EDIT_ORDER alone (can't accept/serve orders, only advance kitchen stages)", async () => {
    await expect(
      guard.requireAnyPermission(kitchenStaffAId, restaurantAId, [PERMISSIONS.EDIT_ORDER]),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("kitchen_staff does NOT satisfy CANCEL_ORDER", async () => {
    await expect(
      guard.requireAnyPermission(kitchenStaffAId, restaurantAId, [PERMISSIONS.CANCEL_ORDER]),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("waiter satisfies [EDIT_ORDER, UPDATE_KDS_STATUS] via EDIT_ORDER alone (mirror image of kitchen_staff)", async () => {
    await expect(
      guard.requireAnyPermission(waiterAId, restaurantAId, [
        PERMISSIONS.EDIT_ORDER,
        PERMISSIONS.UPDATE_KDS_STATUS,
      ]),
    ).resolves.toBeUndefined();
  });

  it("waiter does NOT satisfy UPDATE_KDS_STATUS alone", async () => {
    await expect(
      guard.requireAnyPermission(waiterAId, restaurantAId, [PERMISSIONS.UPDATE_KDS_STATUS]),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("an empty permissions list is always denied, even for the owner (fails closed, never trivially satisfied)", async () => {
    await expect(guard.requireAnyPermission(ownerAId, restaurantAId, [])).rejects.toMatchObject({
      status: 403,
    });
  });

  it("owner B cannot satisfy any permission on restaurant A (tenant isolation holds for the 'any' variant too)", async () => {
    await expect(
      guard.requireAnyPermission(ownerBId, restaurantAId, [
        PERMISSIONS.EDIT_ORDER,
        PERMISSIONS.UPDATE_KDS_STATUS,
        PERMISSIONS.CANCEL_ORDER,
      ]),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("computeOrderPricing snapshots each item's kitchen station, and it survives a real DB round trip", async () => {
    const { computeOrderPricing, generateOrderNumber } = await import("@/lib/orders");

    const pricing = await computeOrderPricing(restaurantAId, [
      { menuItemId: grillItemId, quantity: 1 },
      { menuItemId: barItemId, quantity: 2 },
    ]);

    const grillLine = pricing.items.find((i) => i.menuItemId === grillItemId)!;
    const barLine = pricing.items.find((i) => i.menuItemId === barItemId)!;
    expect(grillLine.kitchenStationId).toBe(grillStationId);
    expect(grillLine.kitchenStationNameSnapshot).toBe("TEST Grill");
    expect(barLine.kitchenStationId).toBe(barStationId);
    expect(barLine.kitchenStationNameSnapshot).toBe("TEST Bar");

    const [order] = await db
      .insert(schema.orders)
      .values({
        restaurantId: restaurantAId,
        branchId: branchAId,
        tableId: null,
        orderNumber: generateOrderNumber(),
        source: "pos",
        status: "pending",
        subtotalInPaisa: pricing.subtotalInPaisa,
        taxInPaisa: pricing.taxInPaisa,
        totalInPaisa: pricing.totalInPaisa,
      })
      .returning({ id: schema.orders.id });

    await db.insert(schema.orderItems).values(
      pricing.items.map((item) => ({
        orderId: order.id,
        menuItemId: item.menuItemId,
        menuItemNameSnapshot: item.menuItemNameSnapshot,
        variantId: item.variantId,
        variantNameSnapshot: item.variantNameSnapshot,
        kitchenStationId: item.kitchenStationId,
        kitchenStationNameSnapshot: item.kitchenStationNameSnapshot,
        unitPriceInPaisa: item.unitPriceInPaisa,
        quantity: item.quantity,
        lineSubtotalInPaisa: item.lineSubtotalInPaisa,
        addonsTotalInPaisa: item.addonsTotalInPaisa,
        lineTotalInPaisa: item.lineTotalInPaisa,
        notes: item.notes,
      })),
    );

    const persisted = await db
      .select({
        menuItemId: schema.orderItems.menuItemId,
        kitchenStationId: schema.orderItems.kitchenStationId,
        kitchenStationNameSnapshot: schema.orderItems.kitchenStationNameSnapshot,
      })
      .from(schema.orderItems)
      .where(and(eq(schema.orderItems.orderId, order.id)));

    const persistedGrill = persisted.find((i) => i.menuItemId === grillItemId)!;
    const persistedBar = persisted.find((i) => i.menuItemId === barItemId)!;
    expect(persistedGrill.kitchenStationId).toBe(grillStationId);
    expect(persistedGrill.kitchenStationNameSnapshot).toBe("TEST Grill");
    expect(persistedBar.kitchenStationId).toBe(barStationId);
    expect(persistedBar.kitchenStationNameSnapshot).toBe("TEST Bar");

    await db.delete(schema.orderItems).where(eq(schema.orderItems.orderId, order.id));
    await db.delete(schema.orders).where(eq(schema.orders.id, order.id));
  });
});
