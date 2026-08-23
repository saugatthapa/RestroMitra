/**
 * Phase 11a integration test: proves requireBranchAccess actually enforces
 * branch scoping — an unrestricted grant (userRoles.branchId === null)
 * reaches every branch of the restaurant, while a branch-scoped grant is
 * confined to exactly the one branch it was assigned — and that the new
 * branchId columns on attendance_records/reservations round-trip through
 * the DB correctly. Live end-to-end HTTP behavior (branch-cap enforcement,
 * cross-branch table/order creation rejection, staff invite, attendance
 * clock-in stamping, reservation branch derivation) is covered by
 * scripts/smoke-test-phase11a.sh; this file is the guard.ts-level unit of
 * enforcement those flows all route through.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Branch access enforcement (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let guard: typeof import("@/lib/rbac/guard");

  let ownerAId: string;
  let managerScopedId: string;
  let restaurantAId: string;
  let restaurantBId: string;
  let mainBranchId: string;
  let secondBranchId: string;
  let restaurantBBranchId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    guard = await import("@/lib/rbac/guard");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [ownerA] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Branch Owner A", phone: `9711${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    const [managerScoped] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Branch Manager", phone: `9712${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    ownerAId = ownerA.id;
    managerScopedId = managerScoped.id;

    const [restaurantA] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-branch-a-${suffix}`, name: "TEST Branch Restaurant A" })
      .returning({ id: schema.restaurants.id });
    const [restaurantB] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-branch-b-${suffix}`, name: "TEST Branch Restaurant B" })
      .returning({ id: schema.restaurants.id });
    restaurantAId = restaurantA.id;
    restaurantBId = restaurantB.id;

    const [mainBranch] = await db
      .insert(schema.branches)
      .values({ restaurantId: restaurantAId, name: "TEST Main Branch", isMain: true })
      .returning({ id: schema.branches.id });
    const [secondBranch] = await db
      .insert(schema.branches)
      .values({ restaurantId: restaurantAId, name: "TEST Second Branch", isMain: false })
      .returning({ id: schema.branches.id });
    mainBranchId = mainBranch.id;
    secondBranchId = secondBranch.id;

    const [branchB] = await db
      .insert(schema.branches)
      .values({ restaurantId: restaurantBId, name: "TEST Restaurant B Main", isMain: true })
      .returning({ id: schema.branches.id });
    restaurantBBranchId = branchB.id;

    await db.insert(schema.userRoles).values([
      { userId: ownerAId, restaurantId: restaurantAId, branchId: null, role: "owner" },
      { userId: managerScopedId, restaurantId: restaurantAId, branchId: secondBranchId, role: "manager" },
    ]);
  });

  afterAll(async () => {
    for (const restaurantId of [restaurantAId, restaurantBId]) {
      await db.delete(schema.userRoles).where(eq(schema.userRoles.restaurantId, restaurantId));
      await db.delete(schema.attendanceRecords).where(eq(schema.attendanceRecords.restaurantId, restaurantId));
      await db.delete(schema.reservations).where(eq(schema.reservations.restaurantId, restaurantId));
      await db.delete(schema.branches).where(eq(schema.branches.restaurantId, restaurantId));
      await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
    }
    await db.delete(schema.users).where(eq(schema.users.id, ownerAId));
    await db.delete(schema.users).where(eq(schema.users.id, managerScopedId));
  });

  it("an unrestricted grant (branchId null) reaches every branch of the restaurant", async () => {
    await expect(
      guard.requireBranchAccess(ownerAId, restaurantAId, mainBranchId),
    ).resolves.toBeUndefined();
    await expect(
      guard.requireBranchAccess(ownerAId, restaurantAId, secondBranchId),
    ).resolves.toBeUndefined();
  });

  // P0-1 regression: before the fix, requireBranchAccess's unrestricted
  // (branchId === null) path returned immediately without ever confirming
  // the REQUESTED branchId actually belongs to the restaurant the caller
  // passed in — meaning an owner/manager/platform_admin with an
  // unrestricted grant on restaurant A could pass restaurant B's branch id
  // straight through unchecked. Every real call site independently
  // re-scopes its own queries by restaurantId (defense in depth), so this
  // was never live-exploitable, but the primitive itself should refuse
  // this on its own.
  it("an unrestricted grant is REJECTED for a branch belonging to a different restaurant entirely", async () => {
    await expect(
      guard.requireBranchAccess(ownerAId, restaurantAId, restaurantBBranchId),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("an unrestricted grant is REJECTED for a branch id that doesn't exist at all", async () => {
    await expect(
      guard.requireBranchAccess(ownerAId, restaurantAId, "00000000-0000-0000-0000-000000000000"),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("a branch-scoped grant reaches its own branch", async () => {
    await expect(
      guard.requireBranchAccess(managerScopedId, restaurantAId, secondBranchId),
    ).resolves.toBeUndefined();
  });

  it("a branch-scoped grant is rejected (403) for a DIFFERENT branch of the same restaurant", async () => {
    await expect(
      guard.requireBranchAccess(managerScopedId, restaurantAId, mainBranchId),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("a branch-scoped grant is rejected for another restaurant's branch entirely", async () => {
    await expect(
      guard.requireBranchAccess(managerScopedId, restaurantAId, restaurantBBranchId),
    ).rejects.toThrow();
  });

  it("requireRestaurantAccess still reports the granted branchId correctly for a scoped user", async () => {
    const access = await guard.requireRestaurantAccess(managerScopedId, restaurantAId);
    expect(access.branchId).toBe(secondBranchId);
    expect(access.role).toBe("manager");
  });

  it("requireRestaurantAccess reports branchId null for an unrestricted owner", async () => {
    const access = await guard.requireRestaurantAccess(ownerAId, restaurantAId);
    expect(access.branchId).toBeNull();
  });

  it("attendance_records.branch_id round-trips (stamped from the clocking-in user's own branch)", async () => {
    const [record] = await db
      .insert(schema.attendanceRecords)
      .values({
        restaurantId: restaurantAId,
        userId: managerScopedId,
        branchId: secondBranchId,
      })
      .returning();
    expect(record.branchId).toBe(secondBranchId);

    // An unrestricted owner clocking in leaves branchId null — not every
    // shift is tied to one physical location.
    const [ownerRecord] = await db
      .insert(schema.attendanceRecords)
      .values({ restaurantId: restaurantAId, userId: ownerAId, branchId: null })
      .returning();
    expect(ownerRecord.branchId).toBeNull();
  });

  it("reservations.branch_id round-trips independently of tableId (a phone booking with no table yet)", async () => {
    const [reservation] = await db
      .insert(schema.reservations)
      .values({
        restaurantId: restaurantAId,
        branchId: secondBranchId,
        tableId: null,
        customerName: "TEST Walk-in Booking",
        customerPhone: "9800000000",
        partySize: 4,
        reservationTime: new Date(Date.now() + 1000 * 60 * 60 * 24),
      })
      .returning();
    expect(reservation.branchId).toBe(secondBranchId);
    expect(reservation.tableId).toBeNull();
  });
});
