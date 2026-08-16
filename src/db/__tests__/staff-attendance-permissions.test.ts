/**
 * Phase 8 integration test: proves (a) MANAGE_STAFF is granted to
 * manager/owner and withheld from waiter/kitchen_staff per the seeded
 * role_permissions data (this is what the staff roster routes and the
 * attendance route's canViewAll branching both depend on), (b) tenant
 * isolation holds for restaurant access resolution — an owner from one
 * restaurant can't resolve access to another's, which every staff/
 * attendance route relies on via resolveRestaurantContext(), and (c) the
 * "at most one active role per user per restaurant" invariant the staff
 * POST route enforces (a DB query, not a DB constraint — see schema.ts's
 * comment) actually finds an existing active grant when one exists.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { PERMISSIONS } from "@/lib/rbac/permissions";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Staff + attendance permissions (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let guard: typeof import("@/lib/rbac/guard");

  let ownerAId: string;
  let managerAId: string;
  let waiterAId: string;
  let kitchenStaffAId: string;
  let ownerBId: string;
  let restaurantAId: string;
  let restaurantBId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    guard = await import("@/lib/rbac/guard");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [ownerA] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Staff Owner A", phone: `9735${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    const [managerA] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Staff Manager A", phone: `9736${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    const [waiterA] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Staff Waiter A", phone: `9737${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    const [kitchenStaffA] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Staff Kitchen A", phone: `9738${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    const [ownerB] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Staff Owner B", phone: `9739${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    ownerAId = ownerA.id;
    managerAId = managerA.id;
    waiterAId = waiterA.id;
    kitchenStaffAId = kitchenStaffA.id;
    ownerBId = ownerB.id;

    const [restaurantA] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-staff-a-${suffix}`, name: "TEST Staff Restaurant A" })
      .returning({ id: schema.restaurants.id });
    const [restaurantB] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-staff-b-${suffix}`, name: "TEST Staff Restaurant B" })
      .returning({ id: schema.restaurants.id });
    restaurantAId = restaurantA.id;
    restaurantBId = restaurantB.id;

    await db.insert(schema.userRoles).values([
      { userId: ownerAId, restaurantId: restaurantAId, role: "owner" },
      { userId: managerAId, restaurantId: restaurantAId, role: "manager" },
      { userId: waiterAId, restaurantId: restaurantAId, role: "waiter" },
      { userId: kitchenStaffAId, restaurantId: restaurantAId, role: "kitchen_staff" },
      { userId: ownerBId, restaurantId: restaurantBId, role: "owner" },
    ]);
  });

  afterAll(async () => {
    await db.delete(schema.attendanceRecords).where(eq(schema.attendanceRecords.restaurantId, restaurantAId));
    await db.delete(schema.userRoles).where(eq(schema.userRoles.restaurantId, restaurantAId));
    await db.delete(schema.userRoles).where(eq(schema.userRoles.restaurantId, restaurantBId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantAId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantBId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerAId));
    await db.delete(schema.users).where(eq(schema.users.id, managerAId));
    await db.delete(schema.users).where(eq(schema.users.id, waiterAId));
    await db.delete(schema.users).where(eq(schema.users.id, kitchenStaffAId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerBId));
  });

  it("manager and owner hold MANAGE_STAFF; waiter and kitchen_staff do not", async () => {
    await expect(guard.hasPermission(managerAId, restaurantAId, PERMISSIONS.MANAGE_STAFF)).resolves.toBe(true);
    await expect(guard.hasPermission(ownerAId, restaurantAId, PERMISSIONS.MANAGE_STAFF)).resolves.toBe(true);
    await expect(guard.hasPermission(waiterAId, restaurantAId, PERMISSIONS.MANAGE_STAFF)).resolves.toBe(false);
    await expect(
      guard.hasPermission(kitchenStaffAId, restaurantAId, PERMISSIONS.MANAGE_STAFF),
    ).resolves.toBe(false);
  });

  it("requirePermission rejects a waiter attempting to manage staff with a 403", async () => {
    await expect(
      guard.requirePermission(waiterAId, restaurantAId, PERMISSIONS.MANAGE_STAFF),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("owner B cannot resolve access to restaurant A (tenant isolation for staff/attendance routes)", async () => {
    await expect(guard.requireRestaurantAccess(ownerBId, restaurantAId)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("a waiter CAN resolve plain restaurant access (no permission needed for self-service attendance)", async () => {
    await expect(guard.requireRestaurantAccess(waiterAId, restaurantAId)).resolves.toMatchObject({
      role: "waiter",
    });
  });

  it("detects an existing active role grant for a user at a restaurant (the query the staff POST route uses to refuse a duplicate add)", async () => {
    const existing = await db
      .select({ id: schema.userRoles.id })
      .from(schema.userRoles)
      .where(
        and(
          eq(schema.userRoles.userId, waiterAId),
          eq(schema.userRoles.restaurantId, restaurantAId),
          eq(schema.userRoles.isActive, true),
        ),
      )
      .limit(1);
    expect(existing).toHaveLength(1);

    // And it correctly finds NOTHING for a user with no grant at this restaurant.
    const none = await db
      .select({ id: schema.userRoles.id })
      .from(schema.userRoles)
      .where(
        and(
          eq(schema.userRoles.userId, ownerBId),
          eq(schema.userRoles.restaurantId, restaurantAId),
          eq(schema.userRoles.isActive, true),
        ),
      )
      .limit(1);
    expect(none).toHaveLength(0);
  });

  it("attendance_records are correctly scoped per restaurant and per user (a real DB round trip)", async () => {
    const [record] = await db
      .insert(schema.attendanceRecords)
      .values({ restaurantId: restaurantAId, userId: waiterAId, note: "TEST shift" })
      .returning();

    expect(record.clockOutAt).toBeNull();

    const [closed] = await db
      .update(schema.attendanceRecords)
      .set({ clockOutAt: new Date() })
      .where(eq(schema.attendanceRecords.id, record.id))
      .returning();
    expect(closed.clockOutAt).not.toBeNull();

    const forOtherUser = await db
      .select()
      .from(schema.attendanceRecords)
      .where(
        and(
          eq(schema.attendanceRecords.restaurantId, restaurantAId),
          eq(schema.attendanceRecords.userId, managerAId),
        ),
      );
    expect(forOtherUser).toHaveLength(0);
  });
});
