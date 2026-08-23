/**
 * RC audit integration test: proves the `payments_order_client_request_id_unique`
 * partial index actually enforces what a payment retry (a dropped response
 * after tapping "Cash Rs 500", or an offline-queued payment synced twice)
 * depends on — a client-generated clientRequestId can only ever back ONE
 * payment row per order, so a legitimate retry of a distinct (non-
 * overpayment) amount can't silently double-insert. This is the
 * schema-level guarantee; the payments POST route's idempotent-replay
 * handling (returning the original payment instead of erroring on the
 * collision — see that route's own doc comment for why the existing
 * `FOR UPDATE` lock on the order row makes this race-safe with no retry
 * loop needed, unlike the orders route) is the application-layer half of
 * the same fix.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("payments.client_request_id uniqueness (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");

  let restaurantId: string;
  let branchId: string;
  let orderAId: string;
  let orderBId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-pay-idem-${suffix}`, name: "TEST Payment Idempotency Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "TEST Main", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;

    const [orderA] = await db
      .insert(schema.orders)
      .values({
        restaurantId,
        branchId,
        orderNumber: `TEST-PAY-A-${suffix}`,
        source: "pos",
        status: "completed",
        subtotalInPaisa: 100_000,
        taxInPaisa: 0,
        totalInPaisa: 100_000,
      })
      .returning({ id: schema.orders.id });
    const [orderB] = await db
      .insert(schema.orders)
      .values({
        restaurantId,
        branchId,
        orderNumber: `TEST-PAY-B-${suffix}`,
        source: "pos",
        status: "completed",
        subtotalInPaisa: 100_000,
        taxInPaisa: 0,
        totalInPaisa: 100_000,
      })
      .returning({ id: schema.orders.id });
    orderAId = orderA.id;
    orderBId = orderB.id;
  });

  afterAll(async () => {
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  function paymentRow(orderId: string, clientRequestId: string | null, amountInPaisa = 50_000) {
    return {
      restaurantId,
      orderId,
      amountInPaisa,
      method: "cash" as const,
      clientRequestId,
    };
  }

  it("rejects a second payment with the same clientRequestId for the same order", async () => {
    const clientRequestId = crypto.randomUUID();
    await db.insert(schema.payments).values(paymentRow(orderAId, clientRequestId));

    // drizzle-orm wraps the underlying postgres.js error in a
    // DrizzleQueryError — the actual Postgres error code lives on `.cause`,
    // same as order-idempotency.test.ts's equivalent assertion.
    await expect(
      db.insert(schema.payments).values(paymentRow(orderAId, clientRequestId)),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
  });

  it("allows the SAME clientRequestId across two different orders", async () => {
    const clientRequestId = crypto.randomUUID();
    const [a] = await db.insert(schema.payments).values(paymentRow(orderAId, clientRequestId)).returning();
    const [b] = await db.insert(schema.payments).values(paymentRow(orderBId, clientRequestId)).returning();

    expect(a.clientRequestId).toBe(clientRequestId);
    expect(b.clientRequestId).toBe(clientRequestId);
    expect(a.id).not.toBe(b.id);
  });

  it("allows unlimited payments with a null clientRequestId (ordinary split-bill payments never collide)", async () => {
    const [first] = await db.insert(schema.payments).values(paymentRow(orderAId, null, 20_000)).returning();
    const [second] = await db.insert(schema.payments).values(paymentRow(orderAId, null, 20_000)).returning();

    expect(first.clientRequestId).toBeNull();
    expect(second.clientRequestId).toBeNull();
    expect(first.id).not.toBe(second.id);
  });
});
