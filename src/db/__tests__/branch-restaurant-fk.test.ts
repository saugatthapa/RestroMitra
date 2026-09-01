/**
 * Gap-audit P1 integration test: proves the composite FOREIGN KEY
 * (branch_id, restaurant_id) REFERENCES branches(id, restaurant_id)
 * constraints added to schema.ts actually reject a branch/restaurant
 * mismatch at the DATABASE layer — not just that requireBranchAccess
 * (src/lib/rbac/guard.ts) catches it in application code. This is the
 * defense-in-depth backstop RESTROMITRA_MASTER_GAP_AUDIT.md's P1 finding
 * asked for: even a route that skipped requireBranchAccess entirely could
 * never actually persist a row whose branchId belongs to a different
 * restaurant than its own restaurantId.
 *
 * Not exhaustive over all 17 tables carrying the constraint (every one
 * follows the exact same "composite FK to branches(id, restaurant_id)"
 * shape, generated identically by drizzle-kit) — this covers one
 * representative table per shape: a NOT NULL branch column (orders), a
 * nullable branch column (holidays), and the two-branch-column table
 * (stock_transfers, which needs BOTH from_branch_id and to_branch_id to
 * agree with restaurant_id). Also proves the branches.id +
 * restaurant_id) unique constraint the composite FKs depend on exists,
 * and that ordinary, correctly-scoped inserts are entirely unaffected.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as
 * check-constraints.test.ts and every other DB-backed integration test in
 * this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Branch/restaurant composite FK (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");

  // Two entirely separate tenants, each with its own branch — the classic
  // "branchId that belongs to someone else's restaurant" shape this
  // constraint exists to catch.
  let restaurantAId: string;
  let branchAId: string;
  let restaurantBId: string;
  let branchBId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurantA] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-branch-fk-a-${suffix}`, name: "TEST Branch-FK Restaurant A" })
      .returning({ id: schema.restaurants.id });
    restaurantAId = restaurantA.id;

    const [branchA] = await db
      .insert(schema.branches)
      .values({ restaurantId: restaurantAId, name: "TEST A Main", isMain: true })
      .returning({ id: schema.branches.id });
    branchAId = branchA.id;

    const [restaurantB] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-branch-fk-b-${suffix}`, name: "TEST Branch-FK Restaurant B" })
      .returning({ id: schema.restaurants.id });
    restaurantBId = restaurantB.id;

    const [branchB] = await db
      .insert(schema.branches)
      .values({ restaurantId: restaurantBId, name: "TEST B Main", isMain: true })
      .returning({ id: schema.branches.id });
    branchBId = branchB.id;
  });

  afterAll(async () => {
    // Cascades to each restaurant's own branch (branches.restaurant_id FK
    // is ON DELETE CASCADE) and anything else this test inserted.
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantAId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantBId));
  });

  it("branches has the composite UNIQUE(id, restaurant_id) the FKs depend on", async () => {
    // Not directly queryable through the query builder; a duplicate
    // (id, restaurantId) pair is impossible to construct anyway since id
    // is a real PK — this instead proves the constraint's actual DDL
    // presence via information_schema, which is what matters: without it,
    // every composite FK below couldn't exist at all (Postgres refuses to
    // create a FK against columns with no unique constraint).
    const { sql } = await import("drizzle-orm");
    const rows = await db.execute(
      sql`select conname from pg_constraint where conname = 'branches_id_restaurant_id_unique' and contype = 'u'`,
    );
    expect(rows.length).toBe(1);
  });

  it("rejects an order whose branchId belongs to a different restaurant (orders_branch_restaurant_fk)", async () => {
    await expect(
      db.insert(schema.orders).values({
        restaurantId: restaurantAId,
        branchId: branchBId, // mismatch — branch B belongs to restaurant B, not A
        orderNumber: `TEST-FK-${Math.random().toString(36).slice(2, 10)}`,
        source: "pos",
        status: "pending",
        subtotalInPaisa: 100_00,
        taxInPaisa: 0,
        totalInPaisa: 100_00,
      }),
    ).rejects.toMatchObject({ cause: { code: "23503" } }); // 23503 = foreign_key_violation
  });

  it("allows an order whose branchId correctly belongs to its own restaurant", async () => {
    const [order] = await db
      .insert(schema.orders)
      .values({
        restaurantId: restaurantAId,
        branchId: branchAId,
        orderNumber: `TEST-FK-OK-${Math.random().toString(36).slice(2, 10)}`,
        source: "pos",
        status: "pending",
        subtotalInPaisa: 100_00,
        taxInPaisa: 0,
        totalInPaisa: 100_00,
      })
      .returning();
    expect(order.branchId).toBe(branchAId);
  });

  it("rejects a stock transfer whose fromBranchId belongs to a different restaurant", async () => {
    await expect(
      db.insert(schema.stockTransfers).values({
        restaurantId: restaurantAId,
        fromBranchId: branchBId, // mismatch
        toBranchId: branchAId,
        status: "requested",
      }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("rejects a stock transfer whose toBranchId belongs to a different restaurant", async () => {
    // Needs a second branch on restaurant A (fromBranchId/toBranchId must
    // be distinct — stock_transfers_branches_distinct) so this exercises
    // ONLY the toBranchId composite FK, not the same-branch check.
    const [branchA2] = await db
      .insert(schema.branches)
      .values({ restaurantId: restaurantAId, name: "TEST A Second Branch" })
      .returning({ id: schema.branches.id });

    await expect(
      db.insert(schema.stockTransfers).values({
        restaurantId: restaurantAId,
        fromBranchId: branchA2.id,
        toBranchId: branchBId, // mismatch
        status: "requested",
      }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("allows a stock transfer whose from/to branches both correctly belong to its own restaurant", async () => {
    const [branchA3] = await db
      .insert(schema.branches)
      .values({ restaurantId: restaurantAId, name: "TEST A Third Branch" })
      .returning({ id: schema.branches.id });

    const [transfer] = await db
      .insert(schema.stockTransfers)
      .values({
        restaurantId: restaurantAId,
        fromBranchId: branchAId,
        toBranchId: branchA3.id,
        status: "requested",
      })
      .returning();
    expect(transfer.fromBranchId).toBe(branchAId);
    expect(transfer.toBranchId).toBe(branchA3.id);
  });

  it("rejects a holiday whose (nullable) branchId belongs to a different restaurant", async () => {
    await expect(
      db.insert(schema.holidays).values({
        restaurantId: restaurantAId,
        branchId: branchBId, // mismatch
        date: "2026-10-20",
        name: "TEST Mismatched Holiday",
      }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("still allows a NULL branchId on a nullable-branch table (MATCH SIMPLE is unaffected)", async () => {
    // The whole point of these being nullable single-column FKs promoted
    // to composite FKs, not NOT NULL ones: a restaurant-wide holiday
    // (branchId NULL) must keep working exactly as before.
    const [holiday] = await db
      .insert(schema.holidays)
      .values({
        restaurantId: restaurantAId,
        branchId: null,
        date: "2026-10-21",
        name: "TEST Restaurant-Wide Holiday",
      })
      .returning();
    expect(holiday.branchId).toBeNull();
  });
});
