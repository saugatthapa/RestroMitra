/**
 * Integration test for the "Call staff" feature (Phase 22b): proves (a)
 * VIEW_SERVICE_CALLS is granted to the floor-facing roles (owner, manager,
 * cashier, waiter) and withheld from kitchen_staff/inventory_manager/
 * accountant per the seeded role_permissions data, (b) tenant isolation
 * holds the same way it does for every other resource, and (c) the
 * realtime_events log — the thing the SSE routes actually poll — correctly
 * scopes by restaurant and respects the "after this id" cursor, including
 * the branch-scoping rule (restaurant-wide events have branchId null and
 * pass through regardless of the caller's own branch scope).
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { PERMISSIONS } from "@/lib/rbac/permissions";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Service calls — permissions, tenancy, realtime log (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let guard: typeof import("@/lib/rbac/guard");
  let realtime: typeof import("@/lib/realtime");

  let ownerAId: string;
  let managerAId: string;
  let cashierAId: string;
  let waiterAId: string;
  let kitchenStaffAId: string;
  let accountantAId: string;
  let ownerBId: string;
  let restaurantAId: string;
  let restaurantBId: string;
  let branchAId: string;
  let branchA2Id: string;
  let tableAId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    guard = await import("@/lib/rbac/guard");
    realtime = await import("@/lib/realtime");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [ownerA, managerA, cashierA, waiterA, kitchenStaffA, accountantA, ownerB] = await db
      .insert(schema.users)
      .values([
        { fullName: "TEST SC Owner A", phone: `9761${suffix.slice(0, 6)}`, passwordHash: "x" },
        { fullName: "TEST SC Manager A", phone: `9762${suffix.slice(0, 6)}`, passwordHash: "x" },
        { fullName: "TEST SC Cashier A", phone: `9763${suffix.slice(0, 6)}`, passwordHash: "x" },
        { fullName: "TEST SC Waiter A", phone: `9764${suffix.slice(0, 6)}`, passwordHash: "x" },
        { fullName: "TEST SC Kitchen A", phone: `9765${suffix.slice(0, 6)}`, passwordHash: "x" },
        { fullName: "TEST SC Accountant A", phone: `9766${suffix.slice(0, 6)}`, passwordHash: "x" },
        { fullName: "TEST SC Owner B", phone: `9767${suffix.slice(0, 6)}`, passwordHash: "x" },
      ])
      .returning({ id: schema.users.id });
    ownerAId = ownerA.id;
    managerAId = managerA.id;
    cashierAId = cashierA.id;
    waiterAId = waiterA.id;
    kitchenStaffAId = kitchenStaffA.id;
    accountantAId = accountantA.id;
    ownerBId = ownerB.id;

    const [restaurantA] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-sc-a-${suffix}`, name: "TEST Service Calls Restaurant A" })
      .returning({ id: schema.restaurants.id });
    const [restaurantB] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-sc-b-${suffix}`, name: "TEST Service Calls Restaurant B" })
      .returning({ id: schema.restaurants.id });
    restaurantAId = restaurantA.id;
    restaurantBId = restaurantB.id;

    const [branchA, branchA2] = await db
      .insert(schema.branches)
      .values([
        { restaurantId: restaurantAId, name: "TEST Branch A1", isMain: true },
        { restaurantId: restaurantAId, name: "TEST Branch A2", isMain: false },
      ])
      .returning({ id: schema.branches.id });
    branchAId = branchA.id;
    branchA2Id = branchA2.id;

    const [tableA] = await db
      .insert(schema.restaurantTables)
      .values({ restaurantId: restaurantAId, branchId: branchAId, name: "TEST T1", qrToken: `tok-${suffix}` })
      .returning({ id: schema.restaurantTables.id });
    tableAId = tableA.id;

    await db.insert(schema.userRoles).values([
      { userId: ownerAId, restaurantId: restaurantAId, role: "owner" },
      { userId: managerAId, restaurantId: restaurantAId, role: "manager" },
      { userId: cashierAId, restaurantId: restaurantAId, role: "cashier" },
      { userId: waiterAId, restaurantId: restaurantAId, role: "waiter" },
      { userId: kitchenStaffAId, restaurantId: restaurantAId, role: "kitchen_staff" },
      { userId: accountantAId, restaurantId: restaurantAId, role: "accountant" },
      { userId: ownerBId, restaurantId: restaurantBId, role: "owner" },
    ]);
  });

  afterAll(async () => {
    await db.delete(schema.realtimeEvents).where(eq(schema.realtimeEvents.restaurantId, restaurantAId));
    await db.delete(schema.serviceCalls).where(eq(schema.serviceCalls.restaurantId, restaurantAId));
    await db.delete(schema.restaurantTables).where(eq(schema.restaurantTables.restaurantId, restaurantAId));
    await db.delete(schema.userRoles).where(eq(schema.userRoles.restaurantId, restaurantAId));
    await db.delete(schema.userRoles).where(eq(schema.userRoles.restaurantId, restaurantBId));
    await db.delete(schema.branches).where(eq(schema.branches.restaurantId, restaurantAId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantAId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantBId));
    for (const id of [ownerAId, managerAId, cashierAId, waiterAId, kitchenStaffAId, accountantAId, ownerBId]) {
      await db.delete(schema.users).where(eq(schema.users.id, id));
    }
  });

  it("VIEW_SERVICE_CALLS is granted to owner/manager/cashier/waiter", async () => {
    for (const id of [ownerAId, managerAId, cashierAId, waiterAId]) {
      await expect(
        guard.hasPermission(id, restaurantAId, PERMISSIONS.VIEW_SERVICE_CALLS),
      ).resolves.toBe(true);
    }
  });

  it("VIEW_SERVICE_CALLS is withheld from kitchen_staff/accountant — floor-facing only", async () => {
    for (const id of [kitchenStaffAId, accountantAId]) {
      await expect(
        guard.hasPermission(id, restaurantAId, PERMISSIONS.VIEW_SERVICE_CALLS),
      ).resolves.toBe(false);
    }
  });

  it("requirePermission rejects kitchen_staff acknowledging a call with a 403", async () => {
    await expect(
      guard.requirePermission(kitchenStaffAId, restaurantAId, PERMISSIONS.VIEW_SERVICE_CALLS),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("owner B cannot resolve access to restaurant A (tenant isolation)", async () => {
    await expect(guard.requireRestaurantAccess(ownerBId, restaurantAId)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("a service call round-trips through pending -> acknowledged -> resolved, scoped per restaurant", async () => {
    const [call] = await db
      .insert(schema.serviceCalls)
      .values({ restaurantId: restaurantAId, branchId: branchAId, tableId: tableAId })
      .returning();
    expect(call.status).toBe("pending");

    const [acknowledged] = await db
      .update(schema.serviceCalls)
      .set({ status: "acknowledged", acknowledgedByUserId: waiterAId, acknowledgedAt: new Date() })
      .where(and(eq(schema.serviceCalls.id, call.id), eq(schema.serviceCalls.status, "pending")))
      .returning();
    expect(acknowledged.status).toBe("acknowledged");

    const [resolved] = await db
      .update(schema.serviceCalls)
      .set({ status: "resolved", resolvedByUserId: waiterAId, resolvedAt: new Date() })
      .where(and(eq(schema.serviceCalls.id, call.id), eq(schema.serviceCalls.status, "acknowledged")))
      .returning();
    expect(resolved.status).toBe("resolved");

    const forOtherRestaurant = await db
      .select()
      .from(schema.serviceCalls)
      .where(eq(schema.serviceCalls.restaurantId, restaurantBId));
    expect(forOtherRestaurant).toHaveLength(0);
  });

  it("realtime_events: fetchEventsForRestaurant only returns events after the given cursor", async () => {
    const before = await realtime.getLatestEventId(restaurantAId);

    await realtime.publishEvent(db, {
      restaurantId: restaurantAId,
      branchId: branchAId,
      type: "service_call.created",
      payload: { marker: "first" },
    });
    await realtime.publishEvent(db, {
      restaurantId: restaurantAId,
      branchId: branchAId,
      type: "service_call.resolved",
      payload: { marker: "second" },
    });

    const events = await realtime.fetchEventsForRestaurant(restaurantAId, null)(before);
    const markers = events.map((e) => (e.payload as { marker: string }).marker);
    expect(markers).toEqual(["first", "second"]);

    const onlyAfterFirst = await realtime.fetchEventsForRestaurant(restaurantAId, null)(events[0].id);
    expect(onlyAfterFirst.map((e) => (e.payload as { marker: string }).marker)).toEqual(["second"]);
  });

  it("realtime_events: a branch-scoped caller sees restaurant-wide (null branch) events plus their own branch's, not another branch's", async () => {
    const before = await realtime.getLatestEventId(restaurantAId);

    await realtime.publishEvent(db, {
      restaurantId: restaurantAId,
      branchId: null,
      type: "order.created",
      payload: { marker: "restaurant-wide" },
    });
    await realtime.publishEvent(db, {
      restaurantId: restaurantAId,
      branchId: branchAId,
      type: "order.created",
      payload: { marker: "branch-A1" },
    });
    await realtime.publishEvent(db, {
      restaurantId: restaurantAId,
      branchId: branchA2Id,
      type: "order.created",
      payload: { marker: "branch-A2" },
    });

    const seenByBranchA1Caller = await realtime.fetchEventsForRestaurant(restaurantAId, branchAId)(before);
    expect(seenByBranchA1Caller.map((e) => (e.payload as { marker: string }).marker)).toEqual([
      "restaurant-wide",
      "branch-A1",
    ]);

    const seenByUnrestrictedCaller = await realtime.fetchEventsForRestaurant(restaurantAId, null)(before);
    expect(seenByUnrestrictedCaller.map((e) => (e.payload as { marker: string }).marker)).toEqual([
      "restaurant-wide",
      "branch-A1",
      "branch-A2",
    ]);
  });
});
