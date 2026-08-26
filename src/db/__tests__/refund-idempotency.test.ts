/**
 * Integration test for the refund idempotency fix (QA hardening pass —
 * financial-atomicity audit, finding #181.2). The refunds route used to
 * accept no client-generated retry key at all, unlike its sibling payments
 * route — a dropped response, a double-click, or an offline-queue replay of
 * the exact same refund submission would insert a SECOND negative-amount
 * payments row and refund the customer twice.
 *
 * Refunds are stored as negative-amount rows in the same `payments` table
 * as regular payments (see schema.ts's comment above the payments table),
 * so they share the same `clientRequestId` column and the same
 * (orderId, clientRequestId) partial unique index that already protects
 * regular payments. This test proves the mechanism directly: two
 * concurrent inserts into `payments` carrying the same
 * (orderId, clientRequestId) pair resolve to exactly one row, exactly the
 * DB-level backstop the refunds route now relies on alongside its
 * application-level idempotent-replay check (itself race-safe only
 * because of the FOR UPDATE lock already taken on the order row — see the
 * route's own doc comment).
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { isUniqueViolation } from "@/lib/db-error";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("refund clientRequestId idempotency (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");

  let restaurantId: string;
  let branchId: string;
  let orderCounter = 0;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-refund-idempotency-${suffix}`, name: "TEST Refund Idempotency Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "TEST Main Branch", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;
  });

  afterAll(async () => {
    if (!db || !schema) return;
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  async function createPaidOrder() {
    orderCounter += 1;
    const [order] = await db
      .insert(schema.orders)
      .values({
        restaurantId,
        branchId,
        orderNumber: `TEST-REFUND-${orderCounter}`,
        status: "completed",
        subtotalInPaisa: 100000,
        taxInPaisa: 0,
        totalInPaisa: 100000,
        paymentStatus: "paid",
      })
      .returning({ id: schema.orders.id });
    await db.insert(schema.payments).values({
      restaurantId,
      orderId: order.id,
      amountInPaisa: 100000,
      method: "cash",
      recordedByUserId: null,
    });
    return order;
  }

  it("a single refund with a clientRequestId inserts one negative-amount row", async () => {
    const order = await createPaidOrder();
    const clientRequestId = `test-refund-${Math.random().toString(36).slice(2, 10)}`;

    const [refund] = await db
      .insert(schema.payments)
      .values({
        restaurantId,
        orderId: order.id,
        amountInPaisa: -50000,
        method: "cash",
        clientRequestId,
        recordedByUserId: null,
      })
      .returning();

    expect(refund.amountInPaisa).toBe(-50000);
    expect(refund.clientRequestId).toBe(clientRequestId);
  });

  it(
    "two concurrent inserts sharing the same (orderId, clientRequestId) resolve to exactly one row — " +
      "the DB-level backstop behind the route's application-level idempotent-replay check",
    async () => {
      const order = await createPaidOrder();
      const clientRequestId = `test-refund-race-${Math.random().toString(36).slice(2, 10)}`;

      const attempt = () =>
        db
          .insert(schema.payments)
          .values({
            restaurantId,
            orderId: order.id,
            amountInPaisa: -50000,
            method: "cash",
            clientRequestId,
            recordedByUserId: null,
          })
          .returning()
          .then((rows) => ({ ok: true as const, rows }))
          .catch((err) => {
            if (isUniqueViolation(err)) return { ok: false as const, rows: [] };
            throw err;
          });

      const [resultA, resultB] = await Promise.all([attempt(), attempt()]);
      const results = [resultA, resultB];

      const winners = results.filter((r) => r.ok);
      const losers = results.filter((r) => !r.ok);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);

      const refundRows = await db
        .select()
        .from(schema.payments)
        .where(eq(schema.payments.orderId, order.id));
      const negativeRows = refundRows.filter((p) => p.amountInPaisa < 0);
      expect(negativeRows).toHaveLength(1);
      expect(negativeRows[0].clientRequestId).toBe(clientRequestId);
    },
  );
});
