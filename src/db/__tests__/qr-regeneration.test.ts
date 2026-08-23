/**
 * RC audit P1 regression test: proves the QR-regeneration mechanics the new
 * POST /api/restaurants/[slug]/tables/[tableId]/qr route relies on — a
 * table's qrToken can be rotated, the OLD token immediately stops
 * resolving to any table (exactly what the public, unauthenticated
 * /order/[token] route's own lookup depends on — see that route's doc
 * comment on the token being the entire access control), the NEW token
 * resolves to the same table, other tables' tokens are untouched, and the
 * unique index still holds after a rotation.
 *
 * The route itself resolves session/permissions via
 * resolveRestaurantContext() + requireBranchAccess(), which this project
 * has no established harness for mocking (same situation as
 * reservation-status-cas.test.ts) — this proves the DB-level guarantee the
 * fix actually depends on directly: generateQrToken() + the UPDATE it
 * feeds.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("QR token regeneration (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let generateQrToken: typeof import("@/lib/qr").generateQrToken;

  let restaurantId: string;
  let branchId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    ({ generateQrToken } = await import("@/lib/qr"));

    const suffix = Math.random().toString(36).slice(2, 8);
    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-qr-regen-${suffix}`, name: "TEST QR Regeneration Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "TEST Main", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;
  });

  afterAll(async () => {
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  async function makeTable(name: string) {
    const [table] = await db
      .insert(schema.restaurantTables)
      .values({ restaurantId, branchId, name, qrToken: generateQrToken() })
      .returning();
    return table;
  }

  async function regenerate(tableId: string) {
    const [updated] = await db
      .update(schema.restaurantTables)
      .set({ qrToken: generateQrToken(), updatedAt: new Date() })
      .where(eq(schema.restaurantTables.id, tableId))
      .returning();
    return updated;
  }

  it("issues a different token than the one before it", async () => {
    const table = await makeTable("TEST Regen Table 1");
    const originalToken = table.qrToken;

    const updated = await regenerate(table.id);
    expect(updated.qrToken).not.toBe(originalToken);
  });

  it("the OLD token no longer resolves to any table — exactly what /order/[token] depends on", async () => {
    const table = await makeTable("TEST Regen Table 2");
    const originalToken = table.qrToken;

    await regenerate(table.id);

    const rows = await db
      .select()
      .from(schema.restaurantTables)
      .where(eq(schema.restaurantTables.qrToken, originalToken));
    expect(rows).toHaveLength(0);
  });

  it("the NEW token resolves to the same table", async () => {
    const table = await makeTable("TEST Regen Table 3");
    const updated = await regenerate(table.id);

    const rows = await db
      .select()
      .from(schema.restaurantTables)
      .where(eq(schema.restaurantTables.qrToken, updated.qrToken));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(table.id);
  });

  it("does not affect another table's token", async () => {
    const tableA = await makeTable("TEST Regen Table A");
    const tableB = await makeTable("TEST Regen Table B");
    const originalBToken = tableB.qrToken;

    await regenerate(tableA.id);

    const [reloadedB] = await db
      .select()
      .from(schema.restaurantTables)
      .where(eq(schema.restaurantTables.id, tableB.id));
    expect(reloadedB.qrToken).toBe(originalBToken);
  });

  it("the unique index on qrToken still holds after a rotation (no duplicate tokens)", async () => {
    const table = await makeTable("TEST Regen Table Unique");
    const updated = await regenerate(table.id);

    await expect(
      db.insert(schema.restaurantTables).values({
        restaurantId,
        branchId,
        name: "TEST Regen Duplicate Attempt",
        qrToken: updated.qrToken, // deliberately reuse the just-issued token
      }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
  });
});
