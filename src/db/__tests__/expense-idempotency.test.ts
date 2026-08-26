/**
 * Integration test for the expense idempotency fix (QA hardening pass —
 * financial-atomicity audit, finding #181.3). The expenses POST route used
 * to accept no client-generated retry key at all — a dropped response, a
 * double-click, or an offline-queued expense submission synced twice would
 * insert a SECOND expense row (and, if status "paid", double-debit the
 * ledger).
 *
 * Same shape as payments-idempotency.test.ts: proves the
 * `expenses_restaurant_client_request_id_unique` partial index actually
 * enforces what the route's clientRequestId pre-check + catch-and-recover
 * (see the route's own doc comment) depends on as its DB-level backstop.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("expenses.client_request_id uniqueness (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");

  let restaurantId: string;
  let categoryId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-expense-idem-${suffix}`, name: "TEST Expense Idempotency Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [category] = await db
      .insert(schema.expenseCategories)
      .values({ restaurantId, name: "TEST Utilities" })
      .returning({ id: schema.expenseCategories.id });
    categoryId = category.id;
  });

  afterAll(async () => {
    if (!db || !schema) return;
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  function expenseRow(clientRequestId: string | null) {
    return {
      restaurantId,
      categoryId,
      amountInPaisa: 50_000,
      description: "TEST electricity bill",
      status: "paid" as const,
      clientRequestId,
    };
  }

  it("rejects a second expense with the same clientRequestId for the same restaurant", async () => {
    const clientRequestId = crypto.randomUUID();
    await db.insert(schema.expenses).values(expenseRow(clientRequestId));

    // drizzle-orm wraps the underlying postgres.js error in a
    // DrizzleQueryError — the actual Postgres error code lives on `.cause`.
    await expect(
      db.insert(schema.expenses).values(expenseRow(clientRequestId)),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
  });

  it("allows unlimited expenses with a null clientRequestId (ordinary submissions never collide)", async () => {
    const [first] = await db.insert(schema.expenses).values(expenseRow(null)).returning();
    const [second] = await db.insert(schema.expenses).values(expenseRow(null)).returning();

    expect(first.clientRequestId).toBeNull();
    expect(second.clientRequestId).toBeNull();
    expect(first.id).not.toBe(second.id);
  });
});
