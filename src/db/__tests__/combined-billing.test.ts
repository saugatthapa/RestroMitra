/**
 * Integration tests for src/lib/combined-billing.ts — the "Combine bill"
 * feature requested right after Table Merge shipped: merging only ever
 * reassigns which table an order sits on (see table-operations.test.ts),
 * it never folds multiple orders into one, so a merged table routinely
 * still needs several orders paid off. These tests exercise the actual
 * settle-oldest-first-in-full allocation, the combined over-amount
 * rejection, replay safety, and the cash-register-open gate — same
 * conventions as cash-register.test.ts/table-operations.test.ts (plain DB
 * fixtures, no RBAC mocking; that's covered by its own tests).
 *
 * Skipped (not failed) when DATABASE_URL isn't set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Combine bill (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let combinedBilling: typeof import("@/lib/combined-billing");
  let cashRegister: typeof import("@/lib/cash-register");

  let restaurantId: string;
  let branchId: string;
  let cashierId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    combinedBilling = await import("@/lib/combined-billing");
    cashRegister = await import("@/lib/cash-register");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-combined-bill-${suffix}`, name: "TEST Combined Bill Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;

    const [cashier] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Combined Bill Cashier", phone: `972${suffix}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    cashierId = cashier.id;
  });

  afterAll(async () => {
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  async function makeTable() {
    const suffix = Math.random().toString(36).slice(2, 8);
    const [table] = await db
      .insert(schema.restaurantTables)
      .values({
        restaurantId,
        branchId,
        name: `T-${suffix}`,
        qrToken: `qr-${suffix}-${Math.random().toString(36).slice(2, 10)}`,
        status: "occupied",
      })
      .returning();
    return table;
  }

  async function makeOrder(tableId: string, totalInPaisa: number, placedAt: Date) {
    const [order] = await db
      .insert(schema.orders)
      .values({
        restaurantId,
        branchId,
        tableId,
        orderNumber: `TEST-CB-${Math.random().toString(36).slice(2, 10)}`,
        source: "pos",
        status: "served",
        subtotalInPaisa: totalInPaisa,
        taxInPaisa: 0,
        totalInPaisa,
        placedAt,
      })
      .returning();
    return order;
  }

  it("getCombinedBillForTable reports each order's own due plus the combined total", async () => {
    const table = await makeTable();
    const order1 = await makeOrder(table.id, 30_000, new Date("2024-03-01T08:00:00Z"));
    const order2 = await makeOrder(table.id, 20_000, new Date("2024-03-01T08:05:00Z"));

    const summary = await db.transaction((tx) =>
      combinedBilling.getCombinedBillForTable(tx, { restaurantId, tableId: table.id }),
    );

    expect(summary.orders.map((o) => o.orderId).sort()).toEqual([order1.id, order2.id].sort());
    expect(summary.combinedRemainingDueInPaisa).toBe(50_000);
  });

  it("pays orders oldest-first, each in full, before moving to the next", async () => {
    const table = await makeTable();
    const older = await makeOrder(table.id, 30_000, new Date("2024-03-02T08:00:00Z"));
    const newer = await makeOrder(table.id, 20_000, new Date("2024-03-02T08:05:00Z"));

    const result = await db.transaction((tx) =>
      combinedBilling.recordCombinedPayment(tx, {
        restaurantId,
        tableId: table.id,
        amountInPaisa: 40_000,
        method: "card",
        recordedByUserId: cashierId,
        timezone: "Asia/Kathmandu",
      }),
    );

    expect(result.touchedOrderIds).toEqual([older.id, newer.id]);
    expect(result.payments).toEqual([
      { orderId: older.id, amountInPaisa: 30_000 },
      { orderId: newer.id, amountInPaisa: 10_000 },
    ]);

    const [olderRow] = await db.select().from(schema.orders).where(eq(schema.orders.id, older.id));
    const [newerRow] = await db.select().from(schema.orders).where(eq(schema.orders.id, newer.id));
    expect(olderRow.paymentStatus).toBe("paid");
    expect(newerRow.paymentStatus).toBe("partially_paid");

    const summary = await db.transaction((tx) =>
      combinedBilling.getCombinedBillForTable(tx, { restaurantId, tableId: table.id }),
    );
    expect(summary.combinedRemainingDueInPaisa).toBe(10_000);
  });

  it("rejects an amount exceeding the combined remaining due, without inserting anything", async () => {
    const table = await makeTable();
    await makeOrder(table.id, 10_000, new Date("2024-03-03T08:00:00Z"));
    await makeOrder(table.id, 10_000, new Date("2024-03-03T08:05:00Z"));

    await expect(
      db.transaction((tx) =>
        combinedBilling.recordCombinedPayment(tx, {
          restaurantId,
          tableId: table.id,
          amountInPaisa: 25_000,
          method: "card",
          recordedByUserId: cashierId,
          timezone: "Asia/Kathmandu",
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });

    const summary = await db.transaction((tx) =>
      combinedBilling.getCombinedBillForTable(tx, { restaurantId, tableId: table.id }),
    );
    expect(summary.combinedRemainingDueInPaisa).toBe(20_000); // untouched
  });

  it("rejects billing a table with no active orders", async () => {
    const table = await makeTable();

    await expect(
      db.transaction((tx) =>
        combinedBilling.recordCombinedPayment(tx, {
          restaurantId,
          tableId: table.id,
          amountInPaisa: 1_000,
          method: "card",
          recordedByUserId: cashierId,
          timezone: "Asia/Kathmandu",
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("a resubmitted request with the same clientRequestId replays instead of double-charging", async () => {
    const table = await makeTable();
    const older = await makeOrder(table.id, 15_000, new Date("2024-03-04T08:00:00Z"));
    const newer = await makeOrder(table.id, 15_000, new Date("2024-03-04T08:05:00Z"));
    const clientRequestId = `test-combined-${Math.random().toString(36).slice(2, 10)}`;

    const first = await db.transaction((tx) =>
      combinedBilling.recordCombinedPayment(tx, {
        restaurantId,
        tableId: table.id,
        amountInPaisa: 20_000,
        method: "card",
        clientRequestId,
        recordedByUserId: cashierId,
        timezone: "Asia/Kathmandu",
      }),
    );
    expect(first.payments).toEqual([
      { orderId: older.id, amountInPaisa: 15_000 },
      { orderId: newer.id, amountInPaisa: 5_000 },
    ]);

    // Same request resent (e.g. the client never saw the first response).
    const replay = await db.transaction((tx) =>
      combinedBilling.recordCombinedPayment(tx, {
        restaurantId,
        tableId: table.id,
        amountInPaisa: 20_000,
        method: "card",
        clientRequestId,
        recordedByUserId: cashierId,
        timezone: "Asia/Kathmandu",
      }),
    );
    expect(replay.payments).toEqual(first.payments);

    const paymentRows = await db
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.orderId, newer.id));
    expect(paymentRows).toHaveLength(1); // not double-inserted
    expect(paymentRows[0].amountInPaisa).toBe(5_000);
  });

  it("rejects a cash payment when no register shift is open at the branch, then allows it once one is", async () => {
    const table = await makeTable();
    await makeOrder(table.id, 5_000, new Date("2024-03-05T08:00:00Z"));

    await expect(
      db.transaction((tx) =>
        combinedBilling.recordCombinedPayment(tx, {
          restaurantId,
          tableId: table.id,
          amountInPaisa: 5_000,
          method: "cash",
          recordedByUserId: cashierId,
          timezone: "Asia/Kathmandu",
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });

    const shift = await db.transaction((tx) =>
      cashRegister.openRegisterShift(tx, {
        restaurantId,
        branchId,
        registerName: "TEST Combined Bill Register",
        openedByUserId: cashierId,
        openingCashInPaisa: 0,
      }),
    );

    const result = await db.transaction((tx) =>
      combinedBilling.recordCombinedPayment(tx, {
        restaurantId,
        tableId: table.id,
        amountInPaisa: 5_000,
        method: "cash",
        recordedByUserId: cashierId,
        timezone: "Asia/Kathmandu",
      }),
    );
    expect(result.payments).toHaveLength(1);

    await db.transaction((tx) =>
      cashRegister.closeRegisterShift(tx, {
        shiftId: shift.id,
        actualCashInPaisa: 5_000,
        closedByUserId: cashierId,
        timezone: "Asia/Kathmandu",
      }),
    );
  });
});
