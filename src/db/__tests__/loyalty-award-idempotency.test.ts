/**
 * Integration test for the loyalty-award idempotency fix (MASTER_GAP_AUDIT
 * P2 — "Loyalty point double-award protection relies on a single call
 * site's transaction guarantee with no database-level backstop"). Before
 * this fix, recordOrderCompletionLoyalty's "earn" award (and its
 * visit-streak bonus) relied ENTIRELY on the order-status state machine
 * never allowing a second transition into "completed" — an app-layer
 * invariant with nothing in the schema stopping two concurrent completions
 * of the same order from both inserting a loyalty_transactions row.
 *
 * Same shape as refund-idempotency.test.ts / stock-movement-concurrency.
 * test.ts: proves the `loyalty_transactions_reference_unique` partial
 * index (on (type, reference_type, reference_id), scoped to rows that set
 * both) is the actual DB-level backstop recordLoyaltyTransaction's
 * onConflictDoNothing depends on, and that racing it for real resolves to
 * exactly one ledger row and one balance credit — not two, and without
 * throwing.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "crypto";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("loyalty award idempotency (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let loyaltyLib: typeof import("@/lib/loyalty");

  let restaurantId: string;
  let customerCounter = 0;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    loyaltyLib = await import("@/lib/loyalty");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-loyalty-idem-${suffix}`, name: "TEST Loyalty Idempotency Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;
  });

  afterAll(async () => {
    if (!db || !schema) return;
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  async function createCustomer() {
    customerCounter += 1;
    const [customer] = await db
      .insert(schema.customers)
      .values({
        restaurantId,
        phone: `98${String(customerCounter).padStart(8, "0")}`,
        fullName: "TEST Loyalty Customer",
      })
      .returning({ id: schema.customers.id });
    return customer.id;
  }

  it(
    "a raw duplicate insert sharing (type, referenceType, referenceId) is rejected by the DB " +
      "(loyalty_transactions_reference_unique actually exists and is enforced)",
    async () => {
      const customerId = await createCustomer();
      const orderId = randomUUID();

      await db.insert(schema.loyaltyTransactions).values({
        restaurantId,
        customerId,
        type: "earn",
        pointsDelta: 10,
        referenceType: "order",
        referenceId: orderId,
      });

      // drizzle-orm wraps the underlying postgres.js error in a
      // DrizzleQueryError — the real Postgres error code lives on `.cause`.
      await expect(
        db.insert(schema.loyaltyTransactions).values({
          restaurantId,
          customerId,
          type: "earn",
          pointsDelta: 10,
          referenceType: "order",
          referenceId: orderId,
        }),
      ).rejects.toMatchObject({ cause: { code: "23505" } });
    },
  );

  it(
    "the same (type, referenceType, referenceId) is allowed to repeat across DIFFERENT types " +
      "— an order's redeem debit and its later earn credit share a referenceId but must both land",
    async () => {
      const customerId = await createCustomer();
      const orderId = randomUUID();

      await db.insert(schema.loyaltyTransactions).values({
        restaurantId,
        customerId,
        type: "redeem",
        pointsDelta: -20,
        referenceType: "order",
        referenceId: orderId,
      });
      const [earnRow] = await db
        .insert(schema.loyaltyTransactions)
        .values({
          restaurantId,
          customerId,
          type: "earn",
          pointsDelta: 30,
          referenceType: "order",
          referenceId: orderId,
        })
        .returning();

      expect(earnRow.pointsDelta).toBe(30);
    },
  );

  it(
    "two concurrent recordLoyaltyTransaction calls for the SAME (type, referenceType, referenceId) " +
      "resolve to exactly one inserted row, one credited balance, and no unhandled exception",
    async () => {
      const customerId = await createCustomer();
      const orderId = randomUUID();

      const attempt = () =>
        db.transaction((tx) =>
          loyaltyLib.recordLoyaltyTransaction(tx, {
            restaurantId,
            customerId,
            type: "earn",
            pointsDelta: 40,
            referenceType: "order",
            referenceId: orderId,
            note: "Earned from order",
          }),
        );

      const [resultA, resultB] = await Promise.all([attempt(), attempt()]);
      const results = [resultA, resultB];

      // Exactly one attempt actually inserted a row; the other silently
      // no-oped (onConflictDoNothing -> null) instead of throwing.
      const winners = results.filter((r) => r !== null);
      const losers = results.filter((r) => r === null);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);

      const rows = await db
        .select()
        .from(schema.loyaltyTransactions)
        .where(
          and(
            eq(schema.loyaltyTransactions.customerId, customerId),
            eq(schema.loyaltyTransactions.referenceType, "order"),
            eq(schema.loyaltyTransactions.referenceId, orderId),
          ),
        );
      expect(rows).toHaveLength(1);
      expect(rows[0].pointsDelta).toBe(40);

      const [customer] = await db
        .select({ loyaltyPointsBalance: schema.customers.loyaltyPointsBalance })
        .from(schema.customers)
        .where(eq(schema.customers.id, customerId));
      // A lost race that let both attempts through would leave this at 80.
      expect(customer.loyaltyPointsBalance).toBe(40);
    },
  );

  it(
    "two concurrent recordOrderCompletionLoyalty calls for the SAME order (the real race this " +
      "guards against — e.g. a retried or duplicated order-status transition) award points once",
    async () => {
      const customerId = await createCustomer();
      const orderId = randomUUID();

      const complete = () =>
        db.transaction((tx) =>
          loyaltyLib.recordOrderCompletionLoyalty(tx, {
            restaurantId,
            customerId,
            orderId,
            totalInPaisa: 125_000, // floor(125000 / 1000) = 125 points
            timezone: "UTC",
          }),
        );

      await Promise.all([complete(), complete()]);

      const earnRows = await db
        .select()
        .from(schema.loyaltyTransactions)
        .where(
          and(
            eq(schema.loyaltyTransactions.customerId, customerId),
            eq(schema.loyaltyTransactions.referenceType, "order"),
            eq(schema.loyaltyTransactions.referenceId, orderId),
            eq(schema.loyaltyTransactions.type, "earn"),
          ),
        );
      expect(earnRows).toHaveLength(1);
      expect(earnRows[0].pointsDelta).toBe(125);

      const [customer] = await db
        .select({
          loyaltyPointsBalance: schema.customers.loyaltyPointsBalance,
          lifetimePointsEarned: schema.customers.lifetimePointsEarned,
        })
        .from(schema.customers)
        .where(eq(schema.customers.id, customerId));
      // Double-award would leave this at 250.
      expect(customer.loyaltyPointsBalance).toBe(125);
      expect(customer.lifetimePointsEarned).toBe(125);
    },
  );
});
