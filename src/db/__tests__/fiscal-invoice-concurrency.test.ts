/**
 * Gap-audit P2 fix (fiscal compliance): regression coverage for the
 * concurrency property assignFiscalInvoiceNumber (src/lib/fiscal-invoice.ts)
 * depends on — a fiscal invoice number must be gapless AND strictly
 * increasing per restaurant, so two bills finalizing (served -> completed)
 * at the same instant must never be handed the same number, and the set of
 * numbers handed out must never skip one.
 *
 * Same shape as stock-movement-concurrency.test.ts: proves the property
 * holds under genuine Promise.all concurrency rather than just trusting the
 * atomic-upsert mechanism by inspection. The underlying mechanism here is
 * `INSERT ... ON CONFLICT (restaurant_id) DO UPDATE SET last_number =
 * last_number + 1 RETURNING last_number` — a SQL-side increment, not a JS
 * read-modify-write — so Postgres serializes concurrent callers on that one
 * counter row.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("assignFiscalInvoiceNumber concurrency (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let fiscalInvoiceLib: typeof import("@/lib/fiscal-invoice");

  let restaurantId: string;
  let branchId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    fiscalInvoiceLib = await import("@/lib/fiscal-invoice");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-fiscal-race-${suffix}`, name: "TEST Fiscal Invoice Race Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "TEST Main Branch", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;
  });

  afterAll(async () => {
    await db.delete(schema.orders).where(eq(schema.orders.restaurantId, restaurantId));
    await db
      .delete(schema.fiscalInvoiceCounters)
      .where(eq(schema.fiscalInvoiceCounters.restaurantId, restaurantId));
    await db.delete(schema.branches).where(eq(schema.branches.restaurantId, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  async function createOrder() {
    const [order] = await db
      .insert(schema.orders)
      .values({
        restaurantId,
        branchId,
        orderNumber: `TEST-${randomUUID().slice(0, 8).toUpperCase()}`,
        source: "pos",
        status: "served",
        subtotalInPaisa: 10_000,
        taxInPaisa: 0,
        totalInPaisa: 10_000,
      })
      .returning({ id: schema.orders.id });
    return order.id;
  }

  it("many concurrent assignments for the SAME restaurant produce a gapless, contiguous, non-duplicate set of numbers", async () => {
    const CONCURRENCY = 12;
    const orderIds = await Promise.all(Array.from({ length: CONCURRENCY }, () => createOrder()));

    const assignments = await Promise.all(
      orderIds.map((orderId) =>
        db.transaction((tx) => fiscalInvoiceLib.assignFiscalInvoiceNumber(tx, { restaurantId, orderId })),
      ),
    );

    const numbers = assignments.map((a) => a.number).sort((a, b) => a - b);

    // No duplicates — a lost update in the counter increment would hand
    // the same number to two different orders.
    expect(new Set(numbers).size).toBe(CONCURRENCY);

    // Gapless and contiguous starting at 1 — this restaurant had never
    // assigned a fiscal invoice number before this test, so the first
    // CONCURRENCY calls must exactly cover 1..CONCURRENCY with no skips.
    expect(numbers).toEqual(Array.from({ length: CONCURRENCY }, (_, i) => i + 1));

    // Every order actually persisted the number it was handed back —
    // assignFiscalInvoiceNumber's own idempotency check (re-reading the
    // order) depends on this having actually been written.
    const rows = await db
      .select({ id: schema.orders.id, fiscalInvoiceNumber: schema.orders.fiscalInvoiceNumber })
      .from(schema.orders)
      .where(eq(schema.orders.restaurantId, restaurantId));
    const byId = new Map(rows.map((r) => [r.id, r.fiscalInvoiceNumber]));
    for (let i = 0; i < orderIds.length; i++) {
      expect(byId.get(orderIds[i])).toBe(assignments[i].number);
    }
  });

  it("is idempotent — calling it again for an order that already has a number returns the SAME number and does not advance the counter", async () => {
    const orderId = await createOrder();

    const first = await db.transaction((tx) =>
      fiscalInvoiceLib.assignFiscalInvoiceNumber(tx, { restaurantId, orderId }),
    );
    const second = await db.transaction((tx) =>
      fiscalInvoiceLib.assignFiscalInvoiceNumber(tx, { restaurantId, orderId }),
    );

    expect(second.number).toBe(first.number);
    expect(second.assignedAt.getTime()).toBe(first.assignedAt.getTime());

    // A fresh order for the same restaurant right after must get the very
    // next number, not one skipped over by the (no-op) second call above.
    const nextOrderId = await createOrder();
    const third = await db.transaction((tx) =>
      fiscalInvoiceLib.assignFiscalInvoiceNumber(tx, { restaurantId, orderId: nextOrderId }),
    );
    expect(third.number).toBe(first.number + 1);
  });

  it("two DIFFERENT restaurants each get their own sequence starting at 1 — one restaurant's volume never affects another's numbering", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const [otherRestaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-fiscal-race-other-${suffix}`, name: "TEST Fiscal Invoice Other Restaurant" })
      .returning({ id: schema.restaurants.id });
    const [otherBranch] = await db
      .insert(schema.branches)
      .values({ restaurantId: otherRestaurant.id, name: "TEST Other Branch", isMain: true })
      .returning({ id: schema.branches.id });

    try {
      const [otherOrder] = await db
        .insert(schema.orders)
        .values({
          restaurantId: otherRestaurant.id,
          branchId: otherBranch.id,
          orderNumber: `TEST-${randomUUID().slice(0, 8).toUpperCase()}`,
          source: "pos",
          status: "served",
          subtotalInPaisa: 5_000,
          taxInPaisa: 0,
          totalInPaisa: 5_000,
        })
        .returning({ id: schema.orders.id });

      const assignment = await db.transaction((tx) =>
        fiscalInvoiceLib.assignFiscalInvoiceNumber(tx, {
          restaurantId: otherRestaurant.id,
          orderId: otherOrder.id,
        }),
      );
      expect(assignment.number).toBe(1);
    } finally {
      await db.delete(schema.orders).where(eq(schema.orders.restaurantId, otherRestaurant.id));
      await db
        .delete(schema.fiscalInvoiceCounters)
        .where(eq(schema.fiscalInvoiceCounters.restaurantId, otherRestaurant.id));
      await db.delete(schema.branches).where(eq(schema.branches.restaurantId, otherRestaurant.id));
      await db.delete(schema.restaurants).where(eq(schema.restaurants.id, otherRestaurant.id));
    }
  });
});
