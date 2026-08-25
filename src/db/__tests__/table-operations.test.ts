/**
 * Commercial Launch Phase B.7 (Table Operations) integration tests for
 * transferOrderToTable/mergeTables/holdOrder/resumeOrder in src/lib/tables.ts.
 *
 * Same convention as coupons.test.ts/customer-credit.test.ts (see their own
 * doc comments): RBAC/branch-access scoping for resolveRestaurantContext()/
 * requireBranchAccess() is covered by its own tests, so this file exercises
 * the business logic directly — CAS locking, cross-branch/out-of-service
 * rejection, "active order" filtering for merge, and hold/resume symmetry.
 *
 * Skipped (not failed) when DATABASE_URL isn't set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Table Operations (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let tables: typeof import("@/lib/tables");

  let ownerId: string;
  let restaurantId: string;
  let otherRestaurantId: string;
  let branchId: string;
  let otherBranchId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    tables = await import("@/lib/tables");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [owner] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Table Ops Owner", phone: `9716${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    ownerId = owner.id;

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-table-ops-${suffix}`, name: "TEST Table Ops Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [otherRestaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-table-ops-other-${suffix}`, name: "TEST Other Restaurant" })
      .returning({ id: schema.restaurants.id });
    otherRestaurantId = otherRestaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;

    const [otherBranch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Second Branch", isMain: false })
      .returning({ id: schema.branches.id });
    otherBranchId = otherBranch.id;
  });

  afterAll(async () => {
    await db.delete(schema.orders).where(eq(schema.orders.restaurantId, restaurantId));
    await db.delete(schema.orders).where(eq(schema.orders.restaurantId, otherRestaurantId));
    await db.delete(schema.restaurantTables).where(eq(schema.restaurantTables.restaurantId, restaurantId));
    await db.delete(schema.restaurantTables).where(eq(schema.restaurantTables.restaurantId, otherRestaurantId));
    await db.delete(schema.branches).where(eq(schema.branches.restaurantId, restaurantId));
    await db.delete(schema.branches).where(eq(schema.branches.restaurantId, otherRestaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, otherRestaurantId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerId));
  });

  async function makeTable(targetRestaurantId: string, targetBranchId: string, overrides: Partial<typeof schema.restaurantTables.$inferInsert> = {}) {
    const suffix = Math.random().toString(36).slice(2, 8);
    const [table] = await db
      .insert(schema.restaurantTables)
      .values({
        restaurantId: targetRestaurantId,
        branchId: targetBranchId,
        name: `T-${suffix}`,
        qrToken: `qr-${suffix}-${Math.random().toString(36).slice(2, 10)}`,
        status: "available",
        ...overrides,
      })
      .returning();
    return table;
  }

  async function makeOrder(
    targetRestaurantId: string,
    targetBranchId: string,
    overrides: Partial<typeof schema.orders.$inferInsert> = {},
  ) {
    const [order] = await db
      .insert(schema.orders)
      .values({
        restaurantId: targetRestaurantId,
        branchId: targetBranchId,
        orderNumber: `TEST-TBL-${Math.random().toString(36).slice(2, 10)}`,
        source: "pos",
        status: "pending",
        subtotalInPaisa: 10_000,
        taxInPaisa: 0,
        totalInPaisa: 10_000,
        ...overrides,
      })
      .returning();
    return order;
  }

  // ---------------------------------------------------------------------
  // transferOrderToTable
  // ---------------------------------------------------------------------

  it("happy path: transferOrderToTable moves the order and re-syncs both tables' derived status", async () => {
    const fromTable = await makeTable(restaurantId, branchId);
    const toTable = await makeTable(restaurantId, branchId);
    const order = await makeOrder(restaurantId, branchId, { tableId: fromTable.id, status: "confirmed" });

    const result = await db.transaction((tx) =>
      tables.transferOrderToTable(tx, { restaurantId, orderId: order.id, toTableId: toTable.id }),
    );
    expect(result.order.tableId).toBe(toTable.id);
    expect(result.fromTableId).toBe(fromTable.id);

    const [toRow] = await db.select().from(schema.restaurantTables).where(eq(schema.restaurantTables.id, toTable.id));
    expect(toRow.status).toBe("occupied"); // a kitchen-active order now sits here

    const [fromRow] = await db
      .select()
      .from(schema.restaurantTables)
      .where(eq(schema.restaurantTables.id, fromTable.id));
    expect(fromRow.status).toBe("available"); // nothing left on the source table
  });

  it("edge case: transferring a takeaway order (null tableId) onto a table succeeds, with no source table to sync", async () => {
    const toTable = await makeTable(restaurantId, branchId);
    const order = await makeOrder(restaurantId, branchId, { tableId: null, status: "pending" });

    const result = await db.transaction((tx) =>
      tables.transferOrderToTable(tx, { restaurantId, orderId: order.id, toTableId: toTable.id }),
    );
    expect(result.fromTableId).toBeNull();
    expect(result.order.tableId).toBe(toTable.id);
  });

  it("validation failure: transferring a cancelled or completed order is rejected", async () => {
    const fromTable = await makeTable(restaurantId, branchId);
    const toTable = await makeTable(restaurantId, branchId);
    const cancelled = await makeOrder(restaurantId, branchId, { tableId: fromTable.id, status: "cancelled" });
    const completed = await makeOrder(restaurantId, branchId, { tableId: fromTable.id, status: "completed" });

    await expect(
      db.transaction((tx) => tables.transferOrderToTable(tx, { restaurantId, orderId: cancelled.id, toTableId: toTable.id })),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      db.transaction((tx) => tables.transferOrderToTable(tx, { restaurantId, orderId: completed.id, toTableId: toTable.id })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("validation failure: transferring onto the order's own current table is rejected", async () => {
    const table = await makeTable(restaurantId, branchId);
    const order = await makeOrder(restaurantId, branchId, { tableId: table.id });

    await expect(
      db.transaction((tx) => tables.transferOrderToTable(tx, { restaurantId, orderId: order.id, toTableId: table.id })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("validation failure: transferring onto an out_of_service table is rejected", async () => {
    const fromTable = await makeTable(restaurantId, branchId);
    const brokenTable = await makeTable(restaurantId, branchId, { status: "out_of_service" });
    const order = await makeOrder(restaurantId, branchId, { tableId: fromTable.id });

    await expect(
      db.transaction((tx) => tables.transferOrderToTable(tx, { restaurantId, orderId: order.id, toTableId: brokenTable.id })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("edge case: transferring across branches within the SAME restaurant is rejected", async () => {
    const fromTable = await makeTable(restaurantId, branchId);
    const otherBranchTable = await makeTable(restaurantId, otherBranchId);
    const order = await makeOrder(restaurantId, branchId, { tableId: fromTable.id });

    await expect(
      db.transaction((tx) =>
        tables.transferOrderToTable(tx, { restaurantId, orderId: order.id, toTableId: otherBranchTable.id }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("wrong-restaurant isolation: an order can never be transferred onto another restaurant's table", async () => {
    const [otherRestaurantBranch] = await db
      .insert(schema.branches)
      .values({ restaurantId: otherRestaurantId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    const foreignTable = await makeTable(otherRestaurantId, otherRestaurantBranch.id);
    const myTable = await makeTable(restaurantId, branchId);
    const order = await makeOrder(restaurantId, branchId, { tableId: myTable.id });

    await expect(
      db.transaction((tx) =>
        tables.transferOrderToTable(tx, { restaurantId, orderId: order.id, toTableId: foreignTable.id }),
      ),
    ).rejects.toMatchObject({ status: 404 }); // requireTableRowLock scopes by restaurantId — not found under this tenant

    await db.delete(schema.branches).where(eq(schema.branches.id, otherRestaurantBranch.id));
  });

  it("unauthorized/not-found: transferring a nonexistent order is rejected", async () => {
    const toTable = await makeTable(restaurantId, branchId);
    await expect(
      db.transaction((tx) =>
        tables.transferOrderToTable(tx, {
          restaurantId,
          orderId: "00000000-0000-0000-0000-000000000099",
          toTableId: toTable.id,
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  // ---------------------------------------------------------------------
  // mergeTables
  // ---------------------------------------------------------------------

  it("happy path: mergeTables moves every active order from the source table, leaving cancelled/completed ones behind", async () => {
    const fromTable = await makeTable(restaurantId, branchId);
    const toTable = await makeTable(restaurantId, branchId);
    const active1 = await makeOrder(restaurantId, branchId, { tableId: fromTable.id, status: "pending" });
    const active2 = await makeOrder(restaurantId, branchId, { tableId: fromTable.id, status: "preparing" });
    const cancelled = await makeOrder(restaurantId, branchId, { tableId: fromTable.id, status: "cancelled" });

    const result = await db.transaction((tx) =>
      tables.mergeTables(tx, { restaurantId, fromTableId: fromTable.id, toTableId: toTable.id }),
    );
    expect(result.movedOrderIds.sort()).toEqual([active1.id, active2.id].sort());

    const [cancelledRow] = await db.select().from(schema.orders).where(eq(schema.orders.id, cancelled.id));
    expect(cancelledRow.tableId).toBe(fromTable.id); // left behind, untouched

    const [active1Row] = await db.select().from(schema.orders).where(eq(schema.orders.id, active1.id));
    expect(active1Row.tableId).toBe(toTable.id);
  });

  it("edge case: merging a source table with no active orders is rejected", async () => {
    const fromTable = await makeTable(restaurantId, branchId);
    const toTable = await makeTable(restaurantId, branchId);
    await makeOrder(restaurantId, branchId, { tableId: fromTable.id, status: "completed" });

    await expect(
      db.transaction((tx) => tables.mergeTables(tx, { restaurantId, fromTableId: fromTable.id, toTableId: toTable.id })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("validation failure: merging a table into itself is rejected", async () => {
    const table = await makeTable(restaurantId, branchId);
    await expect(
      db.transaction((tx) => tables.mergeTables(tx, { restaurantId, fromTableId: table.id, toTableId: table.id })),
    ).rejects.toMatchObject({ status: 400 });
  });

  // ---------------------------------------------------------------------
  // holdOrder / resumeOrder
  // ---------------------------------------------------------------------

  it("happy path: holdOrder sets isOnHold + audit columns; resumeOrder is the symmetric inverse", async () => {
    const order = await makeOrder(restaurantId, branchId, { status: "confirmed" });

    const held = await db.transaction((tx) =>
      tables.holdOrder(tx, { restaurantId, orderId: order.id, userId: ownerId, reason: "Party stepped out" }),
    );
    expect(held.isOnHold).toBe(true);
    expect(held.heldByUserId).toBe(ownerId);
    expect(held.holdReason).toBe("Party stepped out");
    expect(held.heldAt).toBeTruthy();

    const resumed = await db.transaction((tx) => tables.resumeOrder(tx, { restaurantId, orderId: order.id }));
    expect(resumed.isOnHold).toBe(false);
    expect(resumed.heldByUserId).toBeNull();
    expect(resumed.holdReason).toBeNull();
    expect(resumed.heldAt).toBeNull();
  });

  it("edge case: holding an already-held order overwrites the reason instead of erroring (idempotent-safe)", async () => {
    const order = await makeOrder(restaurantId, branchId);
    await db.transaction((tx) => tables.holdOrder(tx, { restaurantId, orderId: order.id, userId: ownerId, reason: "First reason" }));

    const second = await db.transaction((tx) =>
      tables.holdOrder(tx, { restaurantId, orderId: order.id, userId: ownerId, reason: "Updated reason" }),
    );
    expect(second.isOnHold).toBe(true);
    expect(second.holdReason).toBe("Updated reason");
  });

  it("validation failure: holding a cancelled or completed order is rejected", async () => {
    const cancelled = await makeOrder(restaurantId, branchId, { status: "cancelled" });
    await expect(
      db.transaction((tx) => tables.holdOrder(tx, { restaurantId, orderId: cancelled.id, userId: ownerId })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("unauthorized/not-found: holding or resuming a nonexistent order is rejected", async () => {
    await expect(
      db.transaction((tx) =>
        tables.holdOrder(tx, { restaurantId, orderId: "00000000-0000-0000-0000-000000000098", userId: ownerId }),
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      db.transaction((tx) => tables.resumeOrder(tx, { restaurantId, orderId: "00000000-0000-0000-0000-000000000098" })),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("wrong-restaurant isolation: holding another restaurant's order is rejected", async () => {
    const [otherRestaurantBranch] = await db
      .insert(schema.branches)
      .values({ restaurantId: otherRestaurantId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    const foreignOrder = await makeOrder(otherRestaurantId, otherRestaurantBranch.id);

    await expect(
      db.transaction((tx) => tables.holdOrder(tx, { restaurantId, orderId: foreignOrder.id, userId: ownerId })),
    ).rejects.toMatchObject({ status: 404 });

    await db.delete(schema.branches).where(eq(schema.branches.id, otherRestaurantBranch.id));
  });

  it("concurrent request: two simultaneous holdOrder calls on the same order both succeed and leave a consistent final state", async () => {
    const order = await makeOrder(restaurantId, branchId);

    const attempt = (reason: string) =>
      db
        .transaction((tx) => tables.holdOrder(tx, { restaurantId, orderId: order.id, userId: ownerId, reason }))
        .then(() => ({ ok: true as const }))
        .catch(() => ({ ok: false as const }));

    const [a, b] = await Promise.all([attempt("Reason A"), attempt("Reason B")]);
    // Holding is idempotent-by-design (not a CAS-guarded claim like a
    // coupon usage slot) — both concurrent holds are expected to succeed;
    // the only invariant that must hold is the row ends up consistently
    // on-hold with one of the two reasons, never a half-written state.
    expect([a.ok, b.ok]).toEqual([true, true]);

    const [row] = await db.select().from(schema.orders).where(eq(schema.orders.id, order.id));
    expect(row.isOnHold).toBe(true);
    expect(["Reason A", "Reason B"]).toContain(row.holdReason);
  });
});
