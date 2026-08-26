/**
 * Integration test for the expense-void CAS fix (QA hardening pass —
 * financial-atomicity audit). expenses/[expenseId]/route.ts's PATCH used
 * to toggle isVoided with a plain UPDATE ... WHERE id = ? AND
 * restaurantId = ? — no guard on the CURRENT isVoided value. Two
 * concurrent void requests for the same paid expense (a double-click, or
 * two staff members at once) could both read isVoided=false, both pass
 * the "already voided?" check, and both UPDATE would match and commit —
 * whichever ran the ledger-reversal side effect twice would double-credit
 * the ledger for a single void. Every sibling status-transition route in
 * this codebase (expense approve/pay/reject, payroll-payment void, order
 * status, reservation status, service-call ack/resolve) already guards
 * its own UPDATE with a CAS condition on the field being transitioned;
 * this was the one gap.
 *
 * The fix adds `eq(expenses.isVoided, existing.isVoided)` to the UPDATE's
 * WHERE clause whenever the request is actually toggling isVoided. This
 * test proves the mechanism directly: two concurrent conditional UPDATEs
 * against the same row, guarded on the same CAS condition the route now
 * uses, resolve to exactly one winner.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("expenses isVoided CAS (integration)", () => {
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
      .values({ slug: `test-expense-void-cas-${suffix}`, name: "TEST Expense Void CAS Restaurant" })
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

  async function createPaidExpense() {
    const [expense] = await db
      .insert(schema.expenses)
      .values({
        restaurantId,
        categoryId,
        amountInPaisa: 50000,
        description: "TEST electricity bill",
        status: "paid",
        isVoided: false,
      })
      .returning({ id: schema.expenses.id, isVoided: schema.expenses.isVoided });
    return expense;
  }

  it("a single void request succeeds (isVoided goes false -> true)", async () => {
    const expense = await createPaidExpense();
    const [updated] = await db
      .update(schema.expenses)
      .set({ isVoided: true, updatedAt: new Date() })
      .where(and(eq(schema.expenses.id, expense.id), eq(schema.expenses.isVoided, false)))
      .returning();
    expect(updated?.isVoided).toBe(true);
  });

  it(
    "two concurrent void requests for the SAME expense: exactly one wins the CAS-guarded update, " +
      "the other matches zero rows instead of double-processing",
    async () => {
      const expense = await createPaidExpense();

      const [resultA, resultB] = await Promise.all([
        db
          .update(schema.expenses)
          .set({ isVoided: true, updatedAt: new Date() })
          .where(and(eq(schema.expenses.id, expense.id), eq(schema.expenses.isVoided, false)))
          .returning(),
        db
          .update(schema.expenses)
          .set({ isVoided: true, updatedAt: new Date() })
          .where(and(eq(schema.expenses.id, expense.id), eq(schema.expenses.isVoided, false)))
          .returning(),
      ]);

      const winners = [resultA, resultB].filter((r) => r.length > 0);
      const losers = [resultA, resultB].filter((r) => r.length === 0);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);

      // Final state: voided exactly once, not double-toggled back to false
      // or left in some inconsistent state.
      const [finalRow] = await db
        .select({ isVoided: schema.expenses.isVoided })
        .from(schema.expenses)
        .where(eq(schema.expenses.id, expense.id));
      expect(finalRow.isVoided).toBe(true);
    },
  );
});
