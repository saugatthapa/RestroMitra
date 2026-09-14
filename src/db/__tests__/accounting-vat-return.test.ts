/**
 * Integration tests for src/lib/accounting/vat-return.ts — Phase 6, Slice
 * 6c's VAT return / tax summary report. Posts vouchers directly via
 * postVoucher (same pattern accounting-cash-flow.test.ts uses) rather than
 * going through the sales/purchase integrations, since only the resulting
 * ledger activity on "2100 Tax Payable" / "1150 Input VAT Receivable"
 * matters for this report.
 *
 * Skipped (not failed) when DATABASE_URL isn't set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Accounting — VAT return summary (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let chartOfAccountsLib: typeof import("@/lib/accounting/chart-of-accounts");
  let postVoucherLib: typeof import("@/lib/accounting/post-voucher");
  let vatReturnLib: typeof import("@/lib/accounting/vat-return");

  let restaurantId: string;
  let branchId: string;
  let userId: string;
  let cashAccountId: string;
  let salesRevenueAccountId: string;
  let taxPayableAccountId: string;
  let inventoryAccountId: string;
  let inputVatAccountId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    chartOfAccountsLib = await import("@/lib/accounting/chart-of-accounts");
    postVoucherLib = await import("@/lib/accounting/post-voucher");
    vatReturnLib = await import("@/lib/accounting/vat-return");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-vat-return-${suffix}`, name: "TEST VAT Return Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;

    const [user] = await db
      .insert(schema.users)
      .values({ fullName: "TEST VAT Accountant", phone: `977${suffix}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    userId = user.id;

    await db.transaction((tx) => chartOfAccountsLib.seedDefaultChartOfAccounts(tx, { restaurantId }));

    const seeded = await db
      .select({ id: schema.chartOfAccounts.id, code: schema.chartOfAccounts.code })
      .from(schema.chartOfAccounts)
      .where(eq(schema.chartOfAccounts.restaurantId, restaurantId));
    const byCode = new Map(seeded.map((a) => [a.code, a.id]));
    cashAccountId = byCode.get("1000")!;
    salesRevenueAccountId = byCode.get("4000")!;
    taxPayableAccountId = byCode.get("2100")!;
    inventoryAccountId = byCode.get("1200")!;
    inputVatAccountId = byCode.get("1150")!;
  });

  afterAll(async () => {
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  it("nets Output VAT (2100 credits) against Input VAT (1150 debits) for the period, producing a net-payable figure", async () => {
    // A sale collecting 13% VAT: Dr Cash 1130, Cr Sales Revenue 1000, Cr Tax Payable 130.
    await db.transaction((tx) =>
      postVoucherLib.postVoucher(tx, {
        restaurantId,
        branchId,
        voucherType: "sales",
        voucherDate: "2026-08-05",
        createdByUserId: userId,
        lines: [
          { accountId: cashAccountId, debitInPaisa: 1_130_00 },
          { accountId: salesRevenueAccountId, creditInPaisa: 1_000_00 },
          { accountId: taxPayableAccountId, creditInPaisa: 130_00 },
        ],
      }),
    );
    // A VAT-inclusive purchase: Dr Inventory 500, Dr Input VAT 65, Cr Cash 565.
    await db.transaction((tx) =>
      postVoucherLib.postVoucher(tx, {
        restaurantId,
        branchId,
        voucherType: "purchase",
        voucherDate: "2026-08-10",
        createdByUserId: userId,
        lines: [
          { accountId: inventoryAccountId, debitInPaisa: 500_00 },
          { accountId: inputVatAccountId, debitInPaisa: 65_00 },
          { accountId: cashAccountId, creditInPaisa: 565_00 },
        ],
      }),
    );

    const statement = await vatReturnLib.getVatReturnStatement({
      restaurantId,
      fromDate: "2026-08-01",
      toDate: "2026-08-31",
    });

    expect(statement.outputVatInPaisa).toBe(130_00);
    expect(statement.inputVatInPaisa).toBe(65_00);
    expect(statement.netPayableInPaisa).toBe(65_00);
  });

  it("reports a net-refundable (negative) figure when Input VAT exceeds Output VAT in the period", async () => {
    // A large VAT-inclusive purchase with no offsetting sale this period.
    await db.transaction((tx) =>
      postVoucherLib.postVoucher(tx, {
        restaurantId,
        branchId,
        voucherType: "purchase",
        voucherDate: "2026-09-10",
        createdByUserId: userId,
        lines: [
          { accountId: inventoryAccountId, debitInPaisa: 2_000_00 },
          { accountId: inputVatAccountId, debitInPaisa: 260_00 },
          { accountId: cashAccountId, creditInPaisa: 2_260_00 },
        ],
      }),
    );

    const statement = await vatReturnLib.getVatReturnStatement({
      restaurantId,
      fromDate: "2026-09-01",
      toDate: "2026-09-30",
    });

    expect(statement.outputVatInPaisa).toBe(0);
    expect(statement.inputVatInPaisa).toBe(260_00);
    expect(statement.netPayableInPaisa).toBe(-260_00);
  });

  it("excludes activity outside the requested period", async () => {
    await db.transaction((tx) =>
      postVoucherLib.postVoucher(tx, {
        restaurantId,
        branchId,
        voucherType: "sales",
        voucherDate: "2026-10-05",
        createdByUserId: userId,
        lines: [
          { accountId: cashAccountId, debitInPaisa: 226_00 },
          { accountId: salesRevenueAccountId, creditInPaisa: 200_00 },
          { accountId: taxPayableAccountId, creditInPaisa: 26_00 },
        ],
      }),
    );

    const statement = await vatReturnLib.getVatReturnStatement({
      restaurantId,
      fromDate: "2026-11-01",
      toDate: "2026-11-30",
    });
    expect(statement.outputVatInPaisa).toBe(0);
    expect(statement.inputVatInPaisa).toBe(0);
    expect(statement.netPayableInPaisa).toBe(0);
  });

  it("a purchase with no VAT entered contributes nothing to Input VAT", async () => {
    await db.transaction((tx) =>
      postVoucherLib.postVoucher(tx, {
        restaurantId,
        branchId,
        voucherType: "purchase",
        voucherDate: "2026-12-05",
        createdByUserId: userId,
        lines: [
          { accountId: inventoryAccountId, debitInPaisa: 300_00 },
          { accountId: cashAccountId, creditInPaisa: 300_00 },
        ],
      }),
    );

    const statement = await vatReturnLib.getVatReturnStatement({
      restaurantId,
      fromDate: "2026-12-01",
      toDate: "2026-12-31",
    });
    expect(statement.inputVatInPaisa).toBe(0);
  });
});
