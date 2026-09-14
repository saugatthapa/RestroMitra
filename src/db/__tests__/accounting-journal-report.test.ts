/**
 * Integration tests for src/lib/accounting/journal-report.ts — Phase 7,
 * Slice 7c's accounting audit/journal report: every posted voucher in a
 * date range with its full debit/credit lines.
 *
 * Skipped (not failed) when DATABASE_URL isn't set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Accounting — journal report (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let postVoucherLib: typeof import("@/lib/accounting/post-voucher");
  let journalLib: typeof import("@/lib/accounting/journal-report");

  let restaurantId: string;
  let branchId: string;
  let branch2Id: string;
  let userId: string;
  let cashAccountId: string;
  let salesRevenueAccountId: string;
  let cogsAccountId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    postVoucherLib = await import("@/lib/accounting/post-voucher");
    journalLib = await import("@/lib/accounting/journal-report");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-journal-${suffix}`, name: "TEST Journal Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;

    const [branch2] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "TEST Branch 2", isMain: false })
      .returning({ id: schema.branches.id });
    branch2Id = branch2.id;

    const [user] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Journal Accountant", phone: `978${suffix}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    userId = user.id;

    const chartOfAccountsLib = await import("@/lib/accounting/chart-of-accounts");
    await db.transaction((tx) => chartOfAccountsLib.seedDefaultChartOfAccounts(tx, { restaurantId }));
    const seeded = await db
      .select({ id: schema.chartOfAccounts.id, code: schema.chartOfAccounts.code })
      .from(schema.chartOfAccounts)
      .where(eq(schema.chartOfAccounts.restaurantId, restaurantId));
    const byCode = new Map(seeded.map((a) => [a.code, a.id]));
    cashAccountId = byCode.get("1000")!;
    salesRevenueAccountId = byCode.get("4000")!;
    cogsAccountId = byCode.get("5000")!;

    // In range (May), Main branch, sales type.
    await db.transaction((tx) =>
      postVoucherLib.postVoucher(tx, {
        restaurantId,
        branchId,
        voucherType: "sales",
        voucherDate: "2026-05-05",
        narration: "TEST May sale",
        createdByUserId: userId,
        lines: [
          { accountId: cashAccountId, debitInPaisa: 10_000_00 },
          { accountId: salesRevenueAccountId, creditInPaisa: 10_000_00 },
        ],
      }),
    );
    // In range (May), Main branch, expense type.
    await db.transaction((tx) =>
      postVoucherLib.postVoucher(tx, {
        restaurantId,
        branchId,
        voucherType: "expense",
        voucherDate: "2026-05-10",
        narration: "TEST May expense",
        createdByUserId: userId,
        lines: [
          { accountId: cogsAccountId, debitInPaisa: 2_000_00 },
          { accountId: cashAccountId, creditInPaisa: 2_000_00 },
        ],
      }),
    );
    // In range (May), Branch 2, sales type.
    await db.transaction((tx) =>
      postVoucherLib.postVoucher(tx, {
        restaurantId,
        branchId: branch2Id,
        voucherType: "sales",
        voucherDate: "2026-05-15",
        narration: "TEST May Branch 2 sale",
        createdByUserId: userId,
        lines: [
          { accountId: cashAccountId, debitInPaisa: 3_000_00 },
          { accountId: salesRevenueAccountId, creditInPaisa: 3_000_00 },
        ],
      }),
    );
    // Out of range (June) — proves date filtering works.
    await db.transaction((tx) =>
      postVoucherLib.postVoucher(tx, {
        restaurantId,
        branchId,
        voucherType: "sales",
        voucherDate: "2026-06-01",
        narration: "TEST June sale (out of range)",
        createdByUserId: userId,
        lines: [
          { accountId: cashAccountId, debitInPaisa: 5_000_00 },
          { accountId: salesRevenueAccountId, creditInPaisa: 5_000_00 },
        ],
      }),
    );
  });

  afterAll(async () => {
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  it("lists every voucher in the date range with its own lines and totals, excluding vouchers outside the range", async () => {
    const report = await journalLib.getJournalReport({
      restaurantId,
      fromDate: "2026-05-01",
      toDate: "2026-05-31",
    });

    expect(report.voucherCount).toBe(3);
    expect(report.vouchers.map((v) => v.narration).sort()).toEqual(
      ["TEST May Branch 2 sale", "TEST May expense", "TEST May sale"].sort(),
    );

    const saleEntry = report.vouchers.find((v) => v.narration === "TEST May sale")!;
    expect(saleEntry.lines).toHaveLength(2);
    expect(saleEntry.totalDebitInPaisa).toBe(10_000_00);
    expect(saleEntry.totalCreditInPaisa).toBe(10_000_00);
    const cashLine = saleEntry.lines.find((l) => l.accountId === cashAccountId)!;
    expect(cashLine.accountCode).toBe("1000");
    expect(cashLine.debitInPaisa).toBe(10_000_00);

    // Report-level totals sum every voucher's own totals.
    expect(report.totalDebitInPaisa).toBe(10_000_00 + 2_000_00 + 3_000_00);
    expect(report.totalCreditInPaisa).toBe(10_000_00 + 2_000_00 + 3_000_00);

    // Vouchers are in chronological order (May 5, 10, 15).
    expect(report.vouchers.map((v) => v.voucherDate)).toEqual(["2026-05-05", "2026-05-10", "2026-05-15"]);
  });

  it("voucherType narrows to just that type", async () => {
    const report = await journalLib.getJournalReport({
      restaurantId,
      fromDate: "2026-05-01",
      toDate: "2026-05-31",
      voucherType: "expense",
    });
    expect(report.voucherCount).toBe(1);
    expect(report.vouchers[0].narration).toBe("TEST May expense");
    expect(report.voucherType).toBe("expense");
  });

  it("branchId narrows to just that branch's own vouchers", async () => {
    const mainOnly = await journalLib.getJournalReport({
      restaurantId,
      fromDate: "2026-05-01",
      toDate: "2026-05-31",
      branchId,
    });
    expect(mainOnly.voucherCount).toBe(2);
    expect(mainOnly.branchId).toBe(branchId);

    const branch2Only = await journalLib.getJournalReport({
      restaurantId,
      fromDate: "2026-05-01",
      toDate: "2026-05-31",
      branchId: branch2Id,
    });
    expect(branch2Only.voucherCount).toBe(1);
    expect(branch2Only.vouchers[0].branchName).toBe("TEST Branch 2");
  });

  it("returns a clean empty report (not an error) for a period with no activity", async () => {
    const report = await journalLib.getJournalReport({
      restaurantId,
      fromDate: "2020-01-01",
      toDate: "2020-01-31",
    });
    expect(report.voucherCount).toBe(0);
    expect(report.vouchers).toEqual([]);
    expect(report.totalDebitInPaisa).toBe(0);
    expect(report.totalCreditInPaisa).toBe(0);
  });
});
