/**
 * Integration tests for src/lib/accounting/aging.ts — Phase 5, Slice 5a's
 * Accounts Payable / Accounts Receivable aging reports.
 *
 * Unlike financial-statements.test.ts (which posts against fixed seed-style
 * accounts with no party tagging), these tests additionally need
 * `account_mappings` rows for ACCOUNTS_PAYABLE/ACCOUNTS_RECEIVABLE (aging.ts
 * resolves the control account via the mapping, not by account code) and
 * `suppliers`/`customers` fixture rows, with voucher lines tagged via
 * `supplierId`/`customerId` — exactly the "sub-ledger tag" use the schema's
 * own comment on those columns describes.
 *
 * Skipped (not failed) when DATABASE_URL isn't set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Accounting — AR/AP aging (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let postVoucherLib: typeof import("@/lib/accounting/post-voucher");
  let agingLib: typeof import("@/lib/accounting/aging");

  let restaurantId: string;
  let branchId: string;
  let userId: string;
  let cashAccountId: string;
  let apAccountId: string;
  let arAccountId: string;
  let supplierAId: string;
  let supplierBId: string;
  let customerAId: string;

  const TIMEZONE = "Asia/Kathmandu";

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    postVoucherLib = await import("@/lib/accounting/post-voucher");
    agingLib = await import("@/lib/accounting/aging");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-acct-aging-${suffix}`, name: "TEST Aging Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;

    const [user] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Accountant Aging", phone: `976${suffix}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    userId = user.id;

    const accounts = await db
      .insert(schema.chartOfAccounts)
      .values([
        { restaurantId, code: "T1000", name: "TEST Cash", type: "asset", normalBalance: "debit" },
        { restaurantId, code: "T2100", name: "TEST Accounts Payable", type: "liability", normalBalance: "credit" },
        { restaurantId, code: "T1200", name: "TEST Accounts Receivable", type: "asset", normalBalance: "debit" },
      ])
      .returning({ id: schema.chartOfAccounts.id, code: schema.chartOfAccounts.code });
    cashAccountId = accounts.find((a) => a.code === "T1000")!.id;
    apAccountId = accounts.find((a) => a.code === "T2100")!.id;
    arAccountId = accounts.find((a) => a.code === "T1200")!.id;

    await db.insert(schema.accountMappings).values([
      { restaurantId, mappingKey: "control:accounts_payable", accountId: apAccountId },
      { restaurantId, mappingKey: "control:accounts_receivable", accountId: arAccountId },
    ]);

    const suppliers = await db
      .insert(schema.suppliers)
      .values([
        { restaurantId, name: "TEST Supplier A" },
        { restaurantId, name: "TEST Supplier B" },
      ])
      .returning({ id: schema.suppliers.id, name: schema.suppliers.name });
    supplierAId = suppliers.find((s) => s.name === "TEST Supplier A")!.id;
    supplierBId = suppliers.find((s) => s.name === "TEST Supplier B")!.id;

    const [customerA] = await db
      .insert(schema.customers)
      .values({ restaurantId, phone: `977${suffix}`, fullName: "TEST Customer A" })
      .returning({ id: schema.customers.id });
    customerAId = customerA.id;

    const post = (
      voucherDate: string,
      lines: Parameters<typeof postVoucherLib.postVoucher>[1]["lines"],
    ) =>
      db.transaction((tx) =>
        postVoucherLib.postVoucher(tx, {
          restaurantId,
          branchId,
          voucherType: "journal",
          voucherDate,
          createdByUserId: userId,
          lines,
        }),
      );

    // --- Supplier A (Accounts Payable): three charges landing in different
    // buckets as of the fixed asOfDate 2025-04-01, then a partial payment
    // that should consume the OLDEST charge first (FIFO). ---
    // Charge 1: 2025-01-01 -> age 90 days as of Apr 1 -> bucket boundary (61-90 inclusive at 90).
    await post("2025-01-01", [
      { accountId: apAccountId, creditInPaisa: 100_00, supplierId: supplierAId },
      { accountId: cashAccountId, debitInPaisa: 100_00 },
    ]);
    // Charge 2: 2025-03-01 -> age 31 days -> days1to30? Let's compute precisely below via dynamic dates instead.
    await post("2025-03-01", [
      { accountId: apAccountId, creditInPaisa: 200_00, supplierId: supplierAId },
      { accountId: cashAccountId, debitInPaisa: 200_00 },
    ]);
    // Charge 3: 2025-03-25 -> recent, "current" bucket.
    await post("2025-03-25", [
      { accountId: apAccountId, creditInPaisa: 50_00, supplierId: supplierAId },
      { accountId: cashAccountId, debitInPaisa: 50_00 },
    ]);
    // Partial payment of 120 on 2025-03-28 should fully consume charge 1
    // (100) and 20 of charge 2, leaving 180 of charge 2 and all of charge 3.
    await post("2025-03-28", [
      { accountId: apAccountId, debitInPaisa: 120_00, supplierId: supplierAId },
      { accountId: cashAccountId, creditInPaisa: 120_00 },
    ]);

    // --- Supplier B (Accounts Payable): a single charge fully settled ->
    // should NOT appear in the report at all (outstanding = 0). ---
    await post("2025-02-01", [
      { accountId: apAccountId, creditInPaisa: 75_00, supplierId: supplierBId },
      { accountId: cashAccountId, debitInPaisa: 75_00 },
    ]);
    await post("2025-02-10", [
      { accountId: apAccountId, debitInPaisa: 75_00, supplierId: supplierBId },
      { accountId: cashAccountId, creditInPaisa: 75_00 },
    ]);

    // --- Supplier B again: an overpayment producing a negative "current"
    // credit balance. Charge 30, payment 50 -> 20 credit balance.
    await post("2025-03-20", [
      { accountId: apAccountId, creditInPaisa: 30_00, supplierId: supplierBId },
      { accountId: cashAccountId, debitInPaisa: 30_00 },
    ]);
    await post("2025-03-21", [
      { accountId: apAccountId, debitInPaisa: 50_00, supplierId: supplierBId },
      { accountId: cashAccountId, creditInPaisa: 50_00 },
    ]);

    // --- A charge dated AFTER the asOfDate cutoff, to prove date filtering
    // works — should not appear when asOfDate is 2025-04-01. ---
    await post("2025-04-15", [
      { accountId: apAccountId, creditInPaisa: 999_00, supplierId: supplierAId },
      { accountId: cashAccountId, debitInPaisa: 999_00 },
    ]);

    // --- Customer A (Accounts Receivable) mirror: one outstanding charge. ---
    await post("2025-03-15", [
      { accountId: arAccountId, debitInPaisa: 400_00, customerId: customerAId },
      { accountId: cashAccountId, creditInPaisa: 400_00 },
    ]);
  });

  afterAll(async () => {
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  const ASOF = "2025-04-01";

  it("returns null when no Accounts Payable/Receivable account is mapped yet", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const [otherRestaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-acct-aging-nomapping-${suffix}`, name: "TEST No Mapping Restaurant" })
      .returning({ id: schema.restaurants.id });
    try {
      const ap = await agingLib.getAccountsPayableAging(otherRestaurant.id, TIMEZONE, ASOF);
      const ar = await agingLib.getAccountsReceivableAging(otherRestaurant.id, TIMEZONE, ASOF);
      expect(ap).toBeNull();
      expect(ar).toBeNull();
    } finally {
      await db.delete(schema.restaurants).where(eq(schema.restaurants.id, otherRestaurant.id));
    }
  });

  it("Supplier A: FIFO partial settlement consumes the oldest charge first, buckets split correctly", async () => {
    const report = await agingLib.getAccountsPayableAging(restaurantId, TIMEZONE, ASOF);
    expect(report).not.toBeNull();

    const rowA = report!.rows.find((r) => r.partyId === supplierAId);
    expect(rowA).toBeDefined();
    expect(rowA!.partyName).toBe("TEST Supplier A");

    // Charge 1 (100) fully consumed by the 120 payment; charge 2 (200) has
    // 20 consumed, 180 remaining; charge 3 (50) untouched. Total = 230.
    expect(rowA!.outstandingInPaisa).toBe(230_00);

    // Charge 2 dated 2025-03-01 -> 31 days before 2025-04-01 -> days31to60.
    // Charge 3 dated 2025-03-25 -> 7 days before -> days1to30 (the "current"
    // bucket is reserved for age <= 0, i.e. dated on asOfDate itself).
    expect(rowA!.buckets.days31to60).toBe(180_00);
    expect(rowA!.buckets.days1to30).toBe(50_00);
    expect(rowA!.buckets.current).toBe(0);
    expect(rowA!.buckets.days61to90).toBe(0);
    expect(rowA!.buckets.over90).toBe(0);

    // Oldest remaining lot after FIFO consumption is charge 2 (2025-03-01).
    expect(rowA!.oldestChargeDate).toBe("2025-03-01");

    // The 2025-04-15 charge is after asOfDate and must be excluded.
    expect(rowA!.outstandingInPaisa).not.toBe(1229_00);
  });

  it("Supplier B: a fully settled charge does not appear as its own row; an overpayment produces a negative current-bucket credit balance", async () => {
    const report = await agingLib.getAccountsPayableAging(restaurantId, TIMEZONE, ASOF);
    const rowB = report!.rows.find((r) => r.partyId === supplierBId);
    expect(rowB).toBeDefined();

    // The fully-settled 75 charge/payment nets to zero and contributes
    // nothing; only the 30-charge/50-payment overpayment remains: -20.
    expect(rowB!.outstandingInPaisa).toBe(-20_00);
    expect(rowB!.buckets.current).toBe(-20_00);
  });

  it("total outstanding across all parties is the sum of each party's outstanding balance", async () => {
    const report = await agingLib.getAccountsPayableAging(restaurantId, TIMEZONE, ASOF);
    const sum = report!.rows.reduce((s, r) => s + r.outstandingInPaisa, 0);
    expect(report!.totalOutstandingInPaisa).toBe(sum);
  });

  it("asOfDate correctly excludes later-dated vouchers (the 2025-04-15 charge)", async () => {
    const asOfEarly = await agingLib.getAccountsPayableAging(restaurantId, TIMEZONE, "2025-03-28");
    const rowA = asOfEarly!.rows.find((r) => r.partyId === supplierAId);
    // As of 2025-03-28 (same day as the payment, still applied): charge1
    // (100) + charge2 (200) + charge3 (50) - payment(120) = 230, same as
    // above since the 999 charge (Apr 15) and the later cutoff don't matter
    // here — this proves the report is stable/correct at an earlier date too.
    expect(rowA!.outstandingInPaisa).toBe(230_00);

    const asOfLater = await agingLib.getAccountsPayableAging(restaurantId, TIMEZONE, "2025-04-15");
    const rowALater = asOfLater!.rows.find((r) => r.partyId === supplierAId);
    // Now the 999 charge is included: 230 + 999 = 1229.
    expect(rowALater!.outstandingInPaisa).toBe(1229_00);
  });

  it("Accounts Receivable mirror: Customer A's outstanding charge appears with the correct name and bucket", async () => {
    const report = await agingLib.getAccountsReceivableAging(restaurantId, TIMEZONE, ASOF);
    expect(report).not.toBeNull();

    const rowCustomer = report!.rows.find((r) => r.partyId === customerAId);
    expect(rowCustomer).toBeDefined();
    expect(rowCustomer!.partyName).toBe("TEST Customer A");
    expect(rowCustomer!.outstandingInPaisa).toBe(400_00);
    // 2025-03-15 -> 17 days before 2025-04-01 -> days1to30.
    expect(rowCustomer!.buckets.days1to30).toBe(400_00);
  });
});
