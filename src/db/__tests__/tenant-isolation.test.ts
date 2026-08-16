/**
 * Integration test: proves that one restaurant can NEVER access another
 * restaurant's data through the RBAC guard layer (src/lib/rbac/guard.ts).
 *
 * This is the single most important test in Phase 1 per the product spec's
 * own acceptance criteria ("a second restaurant cannot see any of this
 * data"). It requires a real database connection and is skipped (not
 * failed) when DATABASE_URL isn't configured, so `npm test` still works
 * before Supabase credentials are wired up — but it MUST be run at least
 * once against a real database before this is considered done.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { PERMISSIONS } from "@/lib/rbac/permissions";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("tenant isolation (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let guard: typeof import("@/lib/rbac/guard");

  let ownerAId: string;
  let ownerBId: string;
  let staffAId: string; // waiter scoped to a single branch of restaurant A
  let restaurantAId: string;
  let restaurantBId: string;
  let branchAId: string;
  let branchA2Id: string; // second branch of restaurant A, staffA NOT assigned here

  const createdUserIds: string[] = [];

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    guard = await import("@/lib/rbac/guard");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [ownerA] = await db
      .insert(schema.users)
      .values({
        fullName: "TEST Owner A",
        phone: `9700${suffix.slice(0, 6)}`,
        passwordHash: "test-hash-not-used",
      })
      .returning({ id: schema.users.id });
    const [ownerB] = await db
      .insert(schema.users)
      .values({
        fullName: "TEST Owner B",
        phone: `9701${suffix.slice(0, 6)}`,
        passwordHash: "test-hash-not-used",
      })
      .returning({ id: schema.users.id });
    const [staffA] = await db
      .insert(schema.users)
      .values({
        fullName: "TEST Waiter A",
        phone: `9702${suffix.slice(0, 6)}`,
        passwordHash: "test-hash-not-used",
      })
      .returning({ id: schema.users.id });

    ownerAId = ownerA.id;
    ownerBId = ownerB.id;
    staffAId = staffA.id;
    createdUserIds.push(ownerAId, ownerBId, staffAId);

    const [restaurantA] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-resto-a-${suffix}`, name: "TEST Restaurant A" })
      .returning({ id: schema.restaurants.id });
    const [restaurantB] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-resto-b-${suffix}`, name: "TEST Restaurant B" })
      .returning({ id: schema.restaurants.id });

    restaurantAId = restaurantA.id;
    restaurantBId = restaurantB.id;

    const [branchA] = await db
      .insert(schema.branches)
      .values({ restaurantId: restaurantAId, name: "A Main", isMain: true })
      .returning({ id: schema.branches.id });
    const [branchA2] = await db
      .insert(schema.branches)
      .values({ restaurantId: restaurantAId, name: "A Second Branch" })
      .returning({ id: schema.branches.id });

    branchAId = branchA.id;
    branchA2Id = branchA2.id;

    await db.insert(schema.userRoles).values([
      { userId: ownerAId, restaurantId: restaurantAId, role: "owner" },
      { userId: ownerBId, restaurantId: restaurantBId, role: "owner" },
      {
        userId: staffAId,
        restaurantId: restaurantAId,
        branchId: branchAId,
        role: "waiter",
      },
    ]);
  });

  afterAll(async () => {
    await db.delete(schema.userRoles).where(eq(schema.userRoles.userId, ownerAId));
    await db.delete(schema.userRoles).where(eq(schema.userRoles.userId, ownerBId));
    await db.delete(schema.userRoles).where(eq(schema.userRoles.userId, staffAId));
    await db.delete(schema.branches).where(eq(schema.branches.restaurantId, restaurantAId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantAId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantBId));
    for (const id of createdUserIds) {
      await db.delete(schema.users).where(eq(schema.users.id, id));
    }
  });

  it("owner A can access restaurant A", async () => {
    const grant = await guard.requireRestaurantAccess(ownerAId, restaurantAId);
    expect(grant.role).toBe("owner");
  });

  it("owner A CANNOT access restaurant B", async () => {
    await expect(
      guard.requireRestaurantAccess(ownerAId, restaurantBId),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("owner B CANNOT access restaurant A", async () => {
    await expect(
      guard.requireRestaurantAccess(ownerBId, restaurantAId),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("requirePermission rejects a cross-tenant permission check", async () => {
    await expect(
      guard.requirePermission(ownerBId, restaurantAId, PERMISSIONS.VIEW_SALES),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("requirePermission allows owner A to view sales on restaurant A", async () => {
    await expect(
      guard.requirePermission(ownerAId, restaurantAId, PERMISSIONS.VIEW_SALES),
    ).resolves.toBeUndefined();
  });

  it("a branch-scoped waiter can access their own branch", async () => {
    await expect(
      guard.requireBranchAccess(staffAId, restaurantAId, branchAId),
    ).resolves.toBeUndefined();
  });

  it("a branch-scoped waiter CANNOT access a different branch of the SAME restaurant", async () => {
    await expect(
      guard.requireBranchAccess(staffAId, restaurantAId, branchA2Id),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("waiter role does not grant manage_staff even within their own restaurant", async () => {
    await expect(
      guard.requirePermission(staffAId, restaurantAId, PERMISSIONS.MANAGE_STAFF),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("a nonexistent restaurant id is rejected, not silently allowed", async () => {
    await expect(
      guard.requireRestaurantAccess(ownerAId, "00000000-0000-0000-0000-000000000000"),
    ).rejects.toMatchObject({ status: 403 });
  });
});
