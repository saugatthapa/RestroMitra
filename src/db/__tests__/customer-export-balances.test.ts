/**
 * Integration test for getCustomerOutstandingBalancesByRestaurant
 * (src/lib/ledger.ts) — the batched, one-query-for-the-whole-restaurant
 * sibling of getCustomerOutstandingBalance added for the customers CSV
 * export (Data Export gap closed in the commercial completion pass; see
 * src/app/api/restaurants/[slug]/customers/export/route.ts). Proves the
 * grouped aggregate produces the exact same per-customer figures as the
 * already-tested single-customer function (customer-credit.test.ts),
 * across multiple customers, partial settlement, voided entries, and
 * tenant isolation.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as every other
 * DB-backed integration test in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("getCustomerOutstandingBalancesByRestaurant (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let ledger: typeof import("@/lib/ledger");

  let restaurantId: string;
  let otherRestaurantId: string;
  let customerAId: string;
  let customerBId: string;
  let customerNoDuesId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    ledger = await import("@/lib/ledger");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-cust-export-${suffix}`, name: "TEST Customer Export Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [otherRestaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-cust-export-other-${suffix}`, name: "TEST Other Restaurant" })
      .returning({ id: schema.restaurants.id });
    otherRestaurantId = otherRestaurant.id;

    const [customerA] = await db
      .insert(schema.customers)
      .values({ restaurantId, phone: `971${suffix}`, fullName: "TEST Export Customer A" })
      .returning({ id: schema.customers.id });
    customerAId = customerA.id;

    const [customerB] = await db
      .insert(schema.customers)
      .values({ restaurantId, phone: `972${suffix}`, fullName: "TEST Export Customer B" })
      .returning({ id: schema.customers.id });
    customerBId = customerB.id;

    const [customerNoDues] = await db
      .insert(schema.customers)
      .values({ restaurantId, phone: `973${suffix}`, fullName: "TEST Export Customer No Dues" })
      .returning({ id: schema.customers.id });
    customerNoDuesId = customerNoDues.id;

    function ledgerRow(overrides: Partial<typeof schema.ledgerEntries.$inferInsert>) {
      return {
        restaurantId,
        direction: "credit" as const,
        category: "sales" as const,
        description: "TEST order",
        amountInPaisa: 1000_00,
        dueStatus: "outstanding" as const,
        ...overrides,
      };
    }

    await db.insert(schema.ledgerEntries).values([
      // Customer A: one fully-outstanding entry (1000) + one partially
      // settled entry (1000, 400 settled -> 600 outstanding) = 1600 owed.
      ledgerRow({ customerId: customerAId, amountInPaisa: 1000_00 }),
      ledgerRow({ customerId: customerAId, amountInPaisa: 1000_00, settledAmountInPaisa: 400_00 }),
      // Customer B: one outstanding entry (500) + one VOIDED entry (2000,
      // must be excluded) + one fully SETTLED entry (dueStatus "settled",
      // must be excluded since only "outstanding" counts).
      ledgerRow({ customerId: customerBId, amountInPaisa: 500_00 }),
      ledgerRow({ customerId: customerBId, amountInPaisa: 2000_00, isVoided: true }),
      ledgerRow({
        customerId: customerBId,
        amountInPaisa: 300_00,
        settledAmountInPaisa: 300_00,
        dueStatus: "settled",
      }),
      // A manual entry with no customerId at all — must not blow up the
      // group-by or leak into any customer's total.
      ledgerRow({ customerId: null, counterpartyName: "Cash box" }),
      // Different restaurant entirely — must never appear in this
      // restaurant's map even if it happened to reuse the same customer id
      // (it can't here since customers are restaurant-scoped, but the
      // restaurantId filter itself is what's under test).
      ledgerRow({ restaurantId: otherRestaurantId, customerId: null, amountInPaisa: 999_00 }),
    ]);
  });

  afterAll(async () => {
    if (!db || !schema) return;
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, otherRestaurantId));
  });

  it("matches getCustomerOutstandingBalance's per-customer figure for every customer in the restaurant", async () => {
    const balances = await ledger.getCustomerOutstandingBalancesByRestaurant(restaurantId);

    const expectedA = await ledger.getCustomerOutstandingBalance(restaurantId, customerAId);
    const expectedB = await ledger.getCustomerOutstandingBalance(restaurantId, customerBId);

    expect(balances.get(customerAId)).toBe(expectedA);
    expect(balances.get(customerAId)).toBe(1600_00);
    expect(balances.get(customerBId)).toBe(expectedB);
    expect(balances.get(customerBId)).toBe(500_00);
  });

  it("omits a customer with no outstanding entries from the map rather than a zero entry", async () => {
    const balances = await ledger.getCustomerOutstandingBalancesByRestaurant(restaurantId);
    expect(balances.has(customerNoDuesId)).toBe(false);
    // The export route's own lookup handles this via `?? 0` — confirm that
    // reads correctly as zero for a customer absent from the map.
    expect(balances.get(customerNoDuesId) ?? 0).toBe(0);
  });

  it("never includes another restaurant's entries", async () => {
    const balances = await ledger.getCustomerOutstandingBalancesByRestaurant(otherRestaurantId);
    expect(balances.has(customerAId)).toBe(false);
    expect(balances.has(customerBId)).toBe(false);
  });
});
