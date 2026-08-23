/**
 * RC audit integration test: proves the DB-level CHECK constraints added
 * as a defense-in-depth backstop (schema.ts) actually reject bad data at
 * the database layer, not just that the app-layer Zod schemas do — closing
 * the gap where a future direct-SQL script, admin tool, or route that
 * skips validation would otherwise silently write a negative price,
 * quantity, or capacity. Not exhaustive (one representative table per
 * constraint "shape" — non-negative amount, positive-only amount, positive
 * quantity, nullable-but-non-negative), since every constraint follows one
 * of these same few shapes.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("CHECK constraints (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");

  let restaurantId: string;
  let branchId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");

    const suffix = Math.random().toString(36).slice(2, 8);
    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-checks-${suffix}`, name: "TEST Check-Constraints Restaurant" })
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

  it("rejects a negative-total order (orders_amounts_non_negative)", async () => {
    await expect(
      db.insert(schema.orders).values({
        restaurantId,
        branchId,
        orderNumber: `TEST-CHK-${Math.random().toString(36).slice(2, 10)}`,
        source: "pos",
        status: "pending",
        subtotalInPaisa: 100_00,
        taxInPaisa: 0,
        totalInPaisa: -1, // invalid — should be rejected at the DB, not just Zod
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } }); // 23514 = check_violation
  });

  it("rejects a zero/negative-quantity order item (order_items_quantity_positive)", async () => {
    const [order] = await db
      .insert(schema.orders)
      .values({
        restaurantId,
        branchId,
        orderNumber: `TEST-CHK-${Math.random().toString(36).slice(2, 10)}`,
        source: "pos",
        status: "pending",
        subtotalInPaisa: 100_00,
        taxInPaisa: 0,
        totalInPaisa: 100_00,
      })
      .returning({ id: schema.orders.id });

    await expect(
      db.insert(schema.orderItems).values({
        orderId: order.id,
        menuItemNameSnapshot: "TEST Item",
        unitPriceInPaisa: 100_00,
        quantity: 0, // invalid
        lineSubtotalInPaisa: 0,
        lineTotalInPaisa: 0,
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("rejects a zero/negative expense amount (expenses_amount_positive)", async () => {
    const [category] = await db
      .insert(schema.expenseCategories)
      .values({ restaurantId, name: "TEST Category" })
      .returning({ id: schema.expenseCategories.id });

    await expect(
      db.insert(schema.expenses).values({
        restaurantId,
        categoryId: category.id,
        amountInPaisa: 0, // invalid
        description: "TEST expense",
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("allows a null capacity but rejects a zero/negative one (restaurant_tables_capacity_positive)", async () => {
    const [nullCapacity] = await db
      .insert(schema.restaurantTables)
      .values({
        restaurantId,
        branchId,
        name: "TEST Table Null Capacity",
        qrToken: `test-qr-${Math.random().toString(36).slice(2, 10)}`,
      })
      .returning();
    expect(nullCapacity.capacity).toBeNull();

    await expect(
      db.insert(schema.restaurantTables).values({
        restaurantId,
        branchId,
        name: "TEST Table Bad Capacity",
        qrToken: `test-qr-${Math.random().toString(36).slice(2, 10)}`,
        capacity: -1, // invalid
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("still allows every ordinary, valid insert unaffected by these constraints", async () => {
    // Guards against an overly-strict constraint silently breaking normal
    // operation — the exact failure mode the audit's own "do not add
    // constraints that break legitimate existing behavior" instruction warns
    // against.
    const [order] = await db
      .insert(schema.orders)
      .values({
        restaurantId,
        branchId,
        orderNumber: `TEST-CHK-OK-${Math.random().toString(36).slice(2, 10)}`,
        source: "pos",
        status: "completed",
        subtotalInPaisa: 500_00,
        taxInPaisa: 25_00,
        discountInPaisa: 0,
        serviceChargeInPaisa: 0,
        totalInPaisa: 525_00,
      })
      .returning();
    expect(order.totalInPaisa).toBe(525_00);
  });
});
