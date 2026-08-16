/**
 * Phase 3 integration test: proves tables (and their QR tokens) never leak
 * across tenant boundaries, and that an update/delete scoped to the wrong
 * restaurant's id matches zero rows — the exact pattern every tables
 * PATCH/DELETE route relies on (see
 * src/app/api/restaurants/[slug]/tables/[tableId]/route.ts).
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { PERMISSIONS } from "@/lib/rbac/permissions";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("tables tenant isolation (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let guard: typeof import("@/lib/rbac/guard");

  let ownerAId: string;
  let ownerBId: string;
  let restaurantAId: string;
  let restaurantBId: string;
  let branchAId: string;
  let tableAId: string;
  let qrTokenA: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    guard = await import("@/lib/rbac/guard");
    const { generateQrToken } = await import("@/lib/qr");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [ownerA] = await db
      .insert(schema.users)
      .values({
        fullName: "TEST Tables Owner A",
        phone: `9705${suffix.slice(0, 6)}`,
        passwordHash: "test-hash-not-used",
      })
      .returning({ id: schema.users.id });
    const [ownerB] = await db
      .insert(schema.users)
      .values({
        fullName: "TEST Tables Owner B",
        phone: `9706${suffix.slice(0, 6)}`,
        passwordHash: "test-hash-not-used",
      })
      .returning({ id: schema.users.id });
    ownerAId = ownerA.id;
    ownerBId = ownerB.id;

    const [restaurantA] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-tables-a-${suffix}`, name: "TEST Tables Restaurant A" })
      .returning({ id: schema.restaurants.id });
    const [restaurantB] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-tables-b-${suffix}`, name: "TEST Tables Restaurant B" })
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
      { userId: ownerBId, restaurantId: restaurantBId, role: "owner" },
    ]);

    qrTokenA = generateQrToken();
    const [table] = await db
      .insert(schema.restaurantTables)
      .values({
        restaurantId: restaurantAId,
        branchId: branchAId,
        name: "TEST Table 1",
        qrToken: qrTokenA,
      })
      .returning({ id: schema.restaurantTables.id });
    tableAId = table.id;
  });

  afterAll(async () => {
    await db.delete(schema.restaurantTables).where(eq(schema.restaurantTables.id, tableAId));
    await db.delete(schema.branches).where(eq(schema.branches.id, branchAId));
    await db.delete(schema.userRoles).where(eq(schema.userRoles.userId, ownerAId));
    await db.delete(schema.userRoles).where(eq(schema.userRoles.userId, ownerBId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantAId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantBId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerAId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerBId));
  });

  it("owner B cannot resolve restaurant access to restaurant A (precondition for every tables route)", async () => {
    await expect(
      guard.requireRestaurantAccess(ownerBId, restaurantAId),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("owner B is denied manage_tables on restaurant A", async () => {
    await expect(
      guard.requirePermission(ownerBId, restaurantAId, PERMISSIONS.MANAGE_TABLES),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("listing tables scoped to restaurant B never returns restaurant A's table", async () => {
    const rows = await db
      .select()
      .from(schema.restaurantTables)
      .where(eq(schema.restaurantTables.restaurantId, restaurantBId));
    expect(rows.find((t) => t.id === tableAId)).toBeUndefined();
  });

  it("an update scoped to restaurant B's id matches ZERO rows against restaurant A's table", async () => {
    const updated = await db
      .update(schema.restaurantTables)
      .set({ name: "HIJACKED" })
      .where(
        and(
          eq(schema.restaurantTables.id, tableAId),
          eq(schema.restaurantTables.restaurantId, restaurantBId),
        ),
      )
      .returning();
    expect(updated).toHaveLength(0);

    const [stillOriginal] = await db
      .select()
      .from(schema.restaurantTables)
      .where(eq(schema.restaurantTables.id, tableAId));
    expect(stillOriginal.name).toBe("TEST Table 1");
  });

  it("the qrToken is high-entropy and not derivable from the table/restaurant id", () => {
    expect(qrTokenA.length).toBeGreaterThanOrEqual(40);
    expect(qrTokenA).not.toContain(tableAId);
    expect(qrTokenA).not.toContain(restaurantAId);
  });

  it("resolving a table by qrToken (the public order page's lookup) only ever finds the one table that token belongs to", async () => {
    const rows = await db
      .select()
      .from(schema.restaurantTables)
      .where(eq(schema.restaurantTables.qrToken, qrTokenA));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(tableAId);
    expect(rows[0].restaurantId).toBe(restaurantAId);
  });
});
