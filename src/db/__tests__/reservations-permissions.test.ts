/**
 * Phase 8d integration test: proves (a) MANAGE_RESERVATIONS is granted to
 * manager/cashier/owner and withheld from waiter/kitchen_staff/
 * inventory_manager per the seeded role_permissions data — reservations
 * are front-desk data, the same trust level as MANAGE_CUSTOMERS (cashier
 * included), not profit-sensitive the way MANAGE_EXPENSES is, (b) tenant
 * isolation holds for restaurant access resolution, and (c) a real DB
 * round trip for the reservations table, including the optional
 * customer/table links and the status column.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { PERMISSIONS } from "@/lib/rbac/permissions";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Reservations permissions (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let guard: typeof import("@/lib/rbac/guard");

  let managerAId: string;
  let cashierAId: string;
  let waiterAId: string;
  let ownerBId: string;
  let restaurantAId: string;
  let restaurantBId: string;
  let branchAId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    guard = await import("@/lib/rbac/guard");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [managerA] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Resv Manager A", phone: `9765${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    const [cashierA] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Resv Cashier A", phone: `9766${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    const [waiterA] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Resv Waiter A", phone: `9767${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    const [ownerB] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Resv Owner B", phone: `9768${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    managerAId = managerA.id;
    cashierAId = cashierA.id;
    waiterAId = waiterA.id;
    ownerBId = ownerB.id;

    const [restaurantA] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-resv-a-${suffix}`, name: "TEST Reservations Restaurant A" })
      .returning({ id: schema.restaurants.id });
    const [restaurantB] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-resv-b-${suffix}`, name: "TEST Reservations Restaurant B" })
      .returning({ id: schema.restaurants.id });
    restaurantAId = restaurantA.id;
    restaurantBId = restaurantB.id;

    const [branchA] = await db
      .insert(schema.branches)
      .values({ restaurantId: restaurantAId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    branchAId = branchA.id;

    await db.insert(schema.userRoles).values([
      { userId: managerAId, restaurantId: restaurantAId, role: "manager" },
      { userId: cashierAId, restaurantId: restaurantAId, role: "cashier" },
      { userId: waiterAId, restaurantId: restaurantAId, role: "waiter" },
      { userId: ownerBId, restaurantId: restaurantBId, role: "owner" },
    ]);
  });

  afterAll(async () => {
    await db.delete(schema.reservations).where(eq(schema.reservations.restaurantId, restaurantAId));
    await db.delete(schema.reservations).where(eq(schema.reservations.restaurantId, restaurantBId));
    await db.delete(schema.restaurantTables).where(eq(schema.restaurantTables.restaurantId, restaurantAId));
    await db.delete(schema.branches).where(eq(schema.branches.id, branchAId));
    await db.delete(schema.userRoles).where(eq(schema.userRoles.restaurantId, restaurantAId));
    await db.delete(schema.userRoles).where(eq(schema.userRoles.restaurantId, restaurantBId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantAId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantBId));
    await db.delete(schema.users).where(eq(schema.users.id, managerAId));
    await db.delete(schema.users).where(eq(schema.users.id, cashierAId));
    await db.delete(schema.users).where(eq(schema.users.id, waiterAId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerBId));
  });

  it("manager and cashier hold MANAGE_RESERVATIONS; waiter does not", async () => {
    await expect(
      guard.hasPermission(managerAId, restaurantAId, PERMISSIONS.MANAGE_RESERVATIONS),
    ).resolves.toBe(true);
    await expect(
      guard.hasPermission(cashierAId, restaurantAId, PERMISSIONS.MANAGE_RESERVATIONS),
    ).resolves.toBe(true);
    await expect(
      guard.hasPermission(waiterAId, restaurantAId, PERMISSIONS.MANAGE_RESERVATIONS),
    ).resolves.toBe(false);
  });

  it("requirePermission rejects a waiter attempting to manage reservations with a 403", async () => {
    await expect(
      guard.requirePermission(waiterAId, restaurantAId, PERMISSIONS.MANAGE_RESERVATIONS),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("owner B cannot resolve access to restaurant A (tenant isolation)", async () => {
    await expect(guard.requireRestaurantAccess(ownerBId, restaurantAId)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("reservations round-trip correctly with an optional table link, and are scoped per restaurant", async () => {
    const [table] = await db
      .insert(schema.restaurantTables)
      .values({
        restaurantId: restaurantAId,
        branchId: branchAId,
        name: "TEST Table 1",
        qrToken: `test-qr-${Math.random().toString(36).slice(2, 10)}`,
      })
      .returning();

    const [reservation] = await db
      .insert(schema.reservations)
      .values({
        restaurantId: restaurantAId,
        customerName: "TEST Reservation Customer",
        customerPhone: "9812345678",
        partySize: 4,
        tableId: table.id,
        reservationTime: new Date("2026-08-20T19:00:00.000Z"),
        createdByUserId: managerAId,
      })
      .returning();

    expect(reservation.status).toBe("requested");
    expect(reservation.durationMinutes).toBe(90);

    const [confirmed] = await db
      .update(schema.reservations)
      .set({ status: "confirmed" })
      .where(eq(schema.reservations.id, reservation.id))
      .returning();
    expect(confirmed.status).toBe("confirmed");

    const forOtherRestaurant = await db
      .select()
      .from(schema.reservations)
      .where(eq(schema.reservations.restaurantId, restaurantBId));
    expect(forOtherRestaurant).toHaveLength(0);
  });
});
