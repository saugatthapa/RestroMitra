/**
 * Integration test for the payroll payment idempotency fix (QA hardening
 * pass — financial-atomicity audit, finding #181.4). The payroll payments
 * POST route used to accept no client-generated retry key at all — a
 * dropped response, a double-click, or an offline-queued payout synced
 * twice would insert a SECOND payrollPayments row (and double-debit the
 * ledger, and in the worst case actually double-pay the staff member if
 * the manager also physically hands over cash twice believing the first
 * attempt failed).
 *
 * Same shape as payments-idempotency.test.ts / expense-idempotency.test.ts:
 * proves the `payroll_payments_restaurant_client_request_id_unique` partial
 * index actually enforces what the route's clientRequestId pre-check +
 * catch-and-recover (see the route's own doc comment) depends on as its
 * DB-level backstop.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("payrollPayments.client_request_id uniqueness (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");

  let restaurantId: string;
  let userRoleId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-payroll-idem-${suffix}`, name: "TEST Payroll Idempotency Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [user] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Staff Member", phone: `9749${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });

    const [userRole] = await db
      .insert(schema.userRoles)
      .values({ userId: user.id, restaurantId, branchId: null, role: "waiter" })
      .returning({ id: schema.userRoles.id });
    userRoleId = userRole.id;
  });

  afterAll(async () => {
    if (!db || !schema) return;
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  function paymentRow(clientRequestId: string | null) {
    return {
      restaurantId,
      userRoleId,
      staffNameSnapshot: "TEST Staff Member",
      amountInPaisa: 100_000,
      paymentMethod: "cash" as const,
      clientRequestId,
    };
  }

  it("rejects a second payroll payment with the same clientRequestId for the same restaurant", async () => {
    const clientRequestId = crypto.randomUUID();
    await db.insert(schema.payrollPayments).values(paymentRow(clientRequestId));

    // drizzle-orm wraps the underlying postgres.js error in a
    // DrizzleQueryError — the actual Postgres error code lives on `.cause`.
    await expect(
      db.insert(schema.payrollPayments).values(paymentRow(clientRequestId)),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
  });

  it("allows unlimited payroll payments with a null clientRequestId (ordinary payouts never collide)", async () => {
    const [first] = await db.insert(schema.payrollPayments).values(paymentRow(null)).returning();
    const [second] = await db.insert(schema.payrollPayments).values(paymentRow(null)).returning();

    expect(first.clientRequestId).toBeNull();
    expect(second.clientRequestId).toBeNull();
    expect(first.id).not.toBe(second.id);
  });
});
