/**
 * Commercial Launch Phase B.5 (Customer Credit) integration tests for
 * getCustomerOutstandingBalance/settleCustomerCredit in src/lib/ledger.ts,
 * and for recordSalesLedgerEntry's new customerId linkage.
 *
 * Same convention as financial-reconciliation.test.ts/ledger-list.test.ts
 * (see their own doc comments): RBAC/tenant scoping for
 * resolveRestaurantContext() is covered by its own tests, so this file
 * exercises the business logic directly — balance computation, FIFO
 * oldest-first settlement allocation, over/under-payment validation,
 * tenant isolation, and concurrency.
 *
 * Skipped (not failed) when DATABASE_URL isn't set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Customer Credit (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let ledger: typeof import("@/lib/ledger");

  let ownerId: string;
  let restaurantId: string;
  let otherRestaurantId: string;
  let customerId: string;
  let otherCustomerId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    ledger = await import("@/lib/ledger");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [owner] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Credit Owner", phone: `9713${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    ownerId = owner.id;

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-cust-credit-${suffix}`, name: "TEST Customer Credit Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [otherRestaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-cust-credit-other-${suffix}`, name: "TEST Other Restaurant" })
      .returning({ id: schema.restaurants.id });
    otherRestaurantId = otherRestaurant.id;

    const [customer] = await db
      .insert(schema.customers)
      .values({ restaurantId, phone: `981${suffix}`, fullName: "TEST Tab Customer" })
      .returning({ id: schema.customers.id });
    customerId = customer.id;

    const [otherCustomer] = await db
      .insert(schema.customers)
      .values({ restaurantId: otherRestaurantId, phone: `982${suffix}`, fullName: "TEST Other Restaurant Customer" })
      .returning({ id: schema.customers.id });
    otherCustomerId = otherCustomer.id;
  });

  afterAll(async () => {
    await db.delete(schema.ledgerEntries).where(eq(schema.ledgerEntries.restaurantId, restaurantId));
    await db.delete(schema.ledgerEntries).where(eq(schema.ledgerEntries.restaurantId, otherRestaurantId));
    await db.delete(schema.customers).where(eq(schema.customers.id, customerId));
    await db.delete(schema.customers).where(eq(schema.customers.id, otherCustomerId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, otherRestaurantId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerId));
  });

  /** Books a credit sale (an unpaid order-style charge) onto a customer's tab. */
  function chargeToTab(targetCustomerId: string, targetRestaurantId: string, amountInPaisa: number, entryDate?: string) {
    return db.transaction((tx) =>
      ledger.recordLedgerEntry(tx, {
        restaurantId: targetRestaurantId,
        direction: "credit",
        category: "sales",
        amountInPaisa,
        entryDate,
        description: "TEST tab charge",
        markAsDue: true,
        timezone: "UTC",
        recordedByUserId: ownerId,
        customerId: targetCustomerId,
      }),
    );
  }

  it("happy path: recordSalesLedgerEntry links customerId when the order finishes unpaid", async () => {
    const entry = await db.transaction((tx) =>
      ledger.recordSalesLedgerEntry(tx, {
        restaurantId,
        orderId: "00000000-0000-0000-0000-000000000001",
        orderNumber: "TEST-CREDIT-1",
        totalInPaisa: 5_000,
        paymentStatus: "unpaid",
        timezone: "UTC",
        recordedByUserId: ownerId,
        customerId,
      }),
    );
    expect(entry?.customerId).toBe(customerId);
    expect(entry?.dueStatus).toBe("outstanding");

    const balance = await ledger.getCustomerOutstandingBalance(restaurantId, customerId);
    expect(balance).toBeGreaterThanOrEqual(5_000);
  });

  it("happy path: getCustomerOutstandingBalance sums multiple outstanding charges and ignores settled/voided ones", async () => {
    const suffix = Math.random().toString(36).slice(2, 6);
    const [customer] = await db
      .insert(schema.customers)
      .values({ restaurantId, phone: `983${suffix}`, fullName: "TEST Sum Customer" })
      .returning({ id: schema.customers.id });

    const a = await chargeToTab(customer.id, restaurantId, 2_000);
    await chargeToTab(customer.id, restaurantId, 3_000);
    const settledEntry = await chargeToTab(customer.id, restaurantId, 1_000);
    // Fully settle one charge — it must drop out of the outstanding sum.
    await db.transaction((tx) =>
      ledger.settleLedgerDue(tx, {
        restaurantId,
        entryId: settledEntry!.id,
        amountInPaisa: 1_000,
        timezone: "UTC",
        recordedByUserId: ownerId,
      }),
    );
    // A voided charge must also be excluded.
    const voided = await chargeToTab(customer.id, restaurantId, 9_000);
    await db.update(schema.ledgerEntries).set({ isVoided: true }).where(eq(schema.ledgerEntries.id, voided!.id));

    const balance = await ledger.getCustomerOutstandingBalance(restaurantId, customer.id);
    expect(balance).toBe(5_000); // 2,000 + 3,000; not the settled 1,000 or voided 9,000

    expect(a).toBeTruthy();
  });

  it("happy path: settleCustomerCredit pays off a single outstanding charge in full", async () => {
    const suffix = Math.random().toString(36).slice(2, 6);
    const [customer] = await db
      .insert(schema.customers)
      .values({ restaurantId, phone: `984${suffix}`, fullName: "TEST Single Charge Customer" })
      .returning({ id: schema.customers.id });
    await chargeToTab(customer.id, restaurantId, 4_000);

    const result = await db.transaction((tx) =>
      ledger.settleCustomerCredit(tx, {
        restaurantId,
        customerId: customer.id,
        amountInPaisa: 4_000,
        timezone: "UTC",
        recordedByUserId: ownerId,
      }),
    );
    expect(result.appliedInPaisa).toBe(4_000);
    expect(result.settlements).toHaveLength(1);

    const balance = await ledger.getCustomerOutstandingBalance(restaurantId, customer.id);
    expect(balance).toBe(0);
  });

  it("allocates a lump-sum payment across multiple charges oldest-first (FIFO)", async () => {
    const suffix = Math.random().toString(36).slice(2, 6);
    const [customer] = await db
      .insert(schema.customers)
      .values({ restaurantId, phone: `985${suffix}`, fullName: "TEST FIFO Customer" })
      .returning({ id: schema.customers.id });

    const oldest = await chargeToTab(customer.id, restaurantId, 1_000, "2026-01-01");
    const middle = await chargeToTab(customer.id, restaurantId, 2_000, "2026-01-05");
    const newest = await chargeToTab(customer.id, restaurantId, 5_000, "2026-01-10");

    // Enough to fully pay off the oldest and middle charges, plus a partial
    // payment toward the newest.
    const result = await db.transaction((tx) =>
      ledger.settleCustomerCredit(tx, {
        restaurantId,
        customerId: customer.id,
        amountInPaisa: 4_000, // 1,000 + 2,000 + 1,000 toward the newest
        timezone: "UTC",
        recordedByUserId: ownerId,
      }),
    );
    expect(result.appliedInPaisa).toBe(4_000);
    expect(result.settlements).toHaveLength(3);

    const [oldestRow] = await db.select().from(schema.ledgerEntries).where(eq(schema.ledgerEntries.id, oldest!.id));
    const [middleRow] = await db.select().from(schema.ledgerEntries).where(eq(schema.ledgerEntries.id, middle!.id));
    const [newestRow] = await db.select().from(schema.ledgerEntries).where(eq(schema.ledgerEntries.id, newest!.id));
    expect(oldestRow.dueStatus).toBe("settled");
    expect(middleRow.dueStatus).toBe("settled");
    expect(newestRow.dueStatus).toBe("outstanding");
    expect(newestRow.settledAmountInPaisa).toBe(1_000);

    const balance = await ledger.getCustomerOutstandingBalance(restaurantId, customer.id);
    expect(balance).toBe(4_000); // 5,000 - 1,000 applied
  });

  it("validation failure: a non-positive or non-integer amount is rejected", async () => {
    await expect(
      db.transaction((tx) =>
        ledger.settleCustomerCredit(tx, {
          restaurantId,
          customerId,
          amountInPaisa: 0,
          timezone: "UTC",
          recordedByUserId: ownerId,
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      db.transaction((tx) =>
        ledger.settleCustomerCredit(tx, {
          restaurantId,
          customerId,
          amountInPaisa: 10.5,
          timezone: "UTC",
          recordedByUserId: ownerId,
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("validation failure: paying more than the customer's total outstanding balance is rejected, touching nothing", async () => {
    const suffix = Math.random().toString(36).slice(2, 6);
    const [customer] = await db
      .insert(schema.customers)
      .values({ restaurantId, phone: `986${suffix}`, fullName: "TEST Overpay Customer" })
      .returning({ id: schema.customers.id });
    await chargeToTab(customer.id, restaurantId, 1_000);

    await expect(
      db.transaction((tx) =>
        ledger.settleCustomerCredit(tx, {
          restaurantId,
          customerId: customer.id,
          amountInPaisa: 5_000,
          timezone: "UTC",
          recordedByUserId: ownerId,
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });

    // Untouched — the whole attempt was rejected before any entry was settled.
    const balance = await ledger.getCustomerOutstandingBalance(restaurantId, customer.id);
    expect(balance).toBe(1_000);
  });

  it("edge case: a customer with no outstanding balance rejects any settlement attempt", async () => {
    const suffix = Math.random().toString(36).slice(2, 6);
    const [customer] = await db
      .insert(schema.customers)
      .values({ restaurantId, phone: `987${suffix}`, fullName: "TEST Clean Slate Customer" })
      .returning({ id: schema.customers.id });

    await expect(
      db.transaction((tx) =>
        ledger.settleCustomerCredit(tx, {
          restaurantId,
          customerId: customer.id,
          amountInPaisa: 1_000,
          timezone: "UTC",
          recordedByUserId: ownerId,
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("wrong-restaurant isolation: never sums or settles another restaurant's customer/entries", async () => {
    await chargeToTab(otherCustomerId, otherRestaurantId, 7_000);

    const crossBalance = await ledger.getCustomerOutstandingBalance(restaurantId, otherCustomerId);
    expect(crossBalance).toBe(0);

    // Attempting to settle a customer that doesn't belong to `restaurantId`
    // (it belongs to otherRestaurantId) finds nothing outstanding under
    // this restaurant's scope and is rejected — the cross-tenant entry is
    // never touched.
    await expect(
      db.transaction((tx) =>
        ledger.settleCustomerCredit(tx, {
          restaurantId,
          customerId: otherCustomerId,
          amountInPaisa: 1_000,
          timezone: "UTC",
          recordedByUserId: ownerId,
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });

    const ownBalance = await ledger.getCustomerOutstandingBalance(otherRestaurantId, otherCustomerId);
    expect(ownBalance).toBe(7_000);
  });

  it("duplicate request: settling the same amount twice in a row correctly rejects the second call once the balance reaches zero", async () => {
    const suffix = Math.random().toString(36).slice(2, 6);
    const [customer] = await db
      .insert(schema.customers)
      .values({ restaurantId, phone: `988${suffix}`, fullName: "TEST Duplicate Customer" })
      .returning({ id: schema.customers.id });
    await chargeToTab(customer.id, restaurantId, 2_000);

    await db.transaction((tx) =>
      ledger.settleCustomerCredit(tx, {
        restaurantId,
        customerId: customer.id,
        amountInPaisa: 2_000,
        timezone: "UTC",
        recordedByUserId: ownerId,
      }),
    );

    await expect(
      db.transaction((tx) =>
        ledger.settleCustomerCredit(tx, {
          restaurantId,
          customerId: customer.id,
          amountInPaisa: 2_000,
          timezone: "UTC",
          recordedByUserId: ownerId,
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("concurrent request / rollback: two overlapping lump-sum settlements for the same customer never double-apply — the loser rolls back entirely", async () => {
    const suffix = Math.random().toString(36).slice(2, 6);
    const [customer] = await db
      .insert(schema.customers)
      .values({ restaurantId, phone: `989${suffix}`, fullName: "TEST Concurrent Customer" })
      .returning({ id: schema.customers.id });
    await chargeToTab(customer.id, restaurantId, 6_000);

    // Both attempts try to pay the FULL 6,000 balance at once — only one
    // can actually succeed; the other must lose the CAS on at least one
    // entry mid-loop and roll back completely (not leave a partial
    // settlement), so the customer never ends up "overpaid" (negative
    // outstanding) or double-counted.
    const attempt = () =>
      db
        .transaction((tx) =>
          ledger.settleCustomerCredit(tx, {
            restaurantId,
            customerId: customer.id,
            amountInPaisa: 6_000,
            timezone: "UTC",
            recordedByUserId: ownerId,
          }),
        )
        .then((r) => ({ ok: true as const, r }))
        .catch((err) => ({ ok: false as const, err }));

    const [a, b] = await Promise.all([attempt(), attempt()]);
    const outcomes = [a, b];
    const succeeded = outcomes.filter((o) => o.ok);
    const failed = outcomes.filter((o) => !o.ok);

    // Whether Postgres serialized these two transactions (both succeed, one
    // after the other sees the first's committed zero balance and itself
    // gets rejected by the "no outstanding balance" check) or genuinely
    // interleaved them (one wins the CAS race, the other's settleLedgerDue
    // call throws mid-loop and the whole transaction rolls back), the
    // invariant that must hold either way is: exactly one succeeded, and
    // the final balance is exactly zero — never negative, never still 6,000
    // (which would mean the winner's write was somehow lost).
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);

    const finalBalance = await ledger.getCustomerOutstandingBalance(restaurantId, customer.id);
    expect(finalBalance).toBe(0);
  });
});
