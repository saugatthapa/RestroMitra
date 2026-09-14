/**
 * Integration tests for src/lib/accounting/tally-export.ts — Phase 7,
 * Slice 7f's Tally-compatible export. These tests check the XML this
 * module generates against Tally's own documented structure and sign
 * convention (see the module's own top-of-file comment for the source);
 * they cannot and do not verify that a real Tally import accepts the
 * output, since no Tally install is reachable in this environment.
 *
 * Skipped (not failed) when DATABASE_URL isn't set.
 */
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Accounting — Tally export (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let postVoucherLib: typeof import("@/lib/accounting/post-voucher");
  let tallyExportLib: typeof import("@/lib/accounting/tally-export");

  let restaurantId: string;
  let branchId: string;
  let branch2Id: string;
  let userId: string;
  let cashAccountId: string;
  let salesRevenueAccountId: string;
  let cogsAccountId: string;

  const createdRestaurantIds: string[] = [];

  afterEach(async () => {
    for (const id of createdRestaurantIds.splice(0)) {
      await db.delete(schema.restaurants).where(eq(schema.restaurants.id, id));
    }
  });

  async function setup() {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    postVoucherLib = await import("@/lib/accounting/post-voucher");
    tallyExportLib = await import("@/lib/accounting/tally-export");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-tally-${suffix}`, name: "TEST Tally Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;
    createdRestaurantIds.push(restaurantId);

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
      .values({ fullName: "TEST Tally Accountant", phone: `975${suffix}`, passwordHash: "x" })
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
  }

  it("exports a sales voucher with Tally's own sign convention and voucher-type mapping", async () => {
    await setup();
    await db.transaction((tx) =>
      postVoucherLib.postVoucher(tx, {
        restaurantId,
        branchId,
        voucherType: "sales",
        voucherDate: "2026-05-05",
        narration: "TEST cash sale",
        createdByUserId: userId,
        lines: [
          { accountId: cashAccountId, debitInPaisa: 10_000_00 },
          { accountId: salesRevenueAccountId, creditInPaisa: 10_000_00 },
        ],
      }),
    );

    const result = await tallyExportLib.getTallyExport({ restaurantId, fromDate: "2026-05-01", toDate: "2026-05-31" });

    expect(result.voucherCount).toBe(1);
    expect(result.skippedVoucherNumbers).toEqual([]);
    // Structural envelope, per Tally's own documented Vouchers import shape.
    expect(result.xml).toContain("<ENVELOPE>");
    expect(result.xml).toContain("<TALLYREQUEST>Import</TALLYREQUEST>");
    expect(result.xml).toContain("<ID>Vouchers</ID>");
    expect(result.xml).toContain("<TALLYMESSAGE>");
    // Date reformatted to Tally's YYYYMMDD.
    expect(result.xml).toContain("<DATE>20260505</DATE>");
    // "sales" maps to Tally's own "Sales" voucher type.
    expect(result.xml).toContain("<VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>");
    // Debit (Cash on Hand): ISDEEMEDPOSITIVE=Yes, AMOUNT negative — Tally's
    // own documented convention (see this module's own comment for the
    // source example this is copied from).
    expect(result.xml).toContain(
      "<ALLLEDGERENTRIES.LIST><LEDGERNAME>Cash on Hand</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-10000.00</AMOUNT></ALLLEDGERENTRIES.LIST>",
    );
    // Credit (Sales Revenue): ISDEEMEDPOSITIVE=No, AMOUNT positive.
    expect(result.xml).toContain(
      "<ALLLEDGERENTRIES.LIST><LEDGERNAME>Sales Revenue</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>10000.00</AMOUNT></ALLLEDGERENTRIES.LIST>",
    );
  });

  it("maps expense to Payment and excludes vouchers outside the date range", async () => {
    await setup();
    await db.transaction((tx) =>
      postVoucherLib.postVoucher(tx, {
        restaurantId,
        branchId,
        voucherType: "expense",
        voucherDate: "2026-05-10",
        narration: "TEST expense",
        createdByUserId: userId,
        lines: [
          { accountId: cogsAccountId, debitInPaisa: 2_000_00 },
          { accountId: cashAccountId, creditInPaisa: 2_000_00 },
        ],
      }),
    );
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

    const result = await tallyExportLib.getTallyExport({ restaurantId, fromDate: "2026-05-01", toDate: "2026-05-31" });

    expect(result.voucherCount).toBe(1);
    expect(result.xml).toContain("<VOUCHERTYPENAME>Payment</VOUCHERTYPENAME>");
    expect(result.xml).not.toContain("TEST June sale");
  });

  it("escapes XML special characters in ledger names and narration", async () => {
    await setup();
    const [customAccount] = await db
      .insert(schema.chartOfAccounts)
      .values({
        restaurantId,
        code: "9999",
        name: 'R&D "Tools" <Misc>',
        type: "expense",
        normalBalance: "debit",
      })
      .returning({ id: schema.chartOfAccounts.id });

    await db.transaction((tx) =>
      postVoucherLib.postVoucher(tx, {
        restaurantId,
        branchId,
        voucherType: "journal",
        voucherDate: "2026-05-12",
        narration: "TEST <adjustment> for R&D",
        createdByUserId: userId,
        lines: [
          { accountId: customAccount.id, debitInPaisa: 500_00 },
          { accountId: cashAccountId, creditInPaisa: 500_00 },
        ],
      }),
    );

    const result = await tallyExportLib.getTallyExport({ restaurantId, fromDate: "2026-05-01", toDate: "2026-05-31" });

    expect(result.xml).toContain("R&amp;D &quot;Tools&quot; &lt;Misc&gt;");
    expect(result.xml).toContain("TEST &lt;adjustment&gt; for R&amp;D");
    expect(result.xml).not.toContain("<Misc>");
  });

  it("names the branch in narration when the export spans more than one branch, and omits it when scoped to one", async () => {
    await setup();
    await db.transaction((tx) =>
      postVoucherLib.postVoucher(tx, {
        restaurantId,
        branchId,
        voucherType: "sales",
        voucherDate: "2026-05-05",
        narration: "TEST main branch sale",
        createdByUserId: userId,
        lines: [
          { accountId: cashAccountId, debitInPaisa: 1_000_00 },
          { accountId: salesRevenueAccountId, creditInPaisa: 1_000_00 },
        ],
      }),
    );
    await db.transaction((tx) =>
      postVoucherLib.postVoucher(tx, {
        restaurantId,
        branchId: branch2Id,
        voucherType: "sales",
        voucherDate: "2026-05-06",
        narration: "TEST branch 2 sale",
        createdByUserId: userId,
        lines: [
          { accountId: cashAccountId, debitInPaisa: 2_000_00 },
          { accountId: salesRevenueAccountId, creditInPaisa: 2_000_00 },
        ],
      }),
    );

    const unscoped = await tallyExportLib.getTallyExport({ restaurantId, fromDate: "2026-05-01", toDate: "2026-05-31" });
    expect(unscoped.xml).toContain("Branch: TEST Branch 2");

    const scoped = await tallyExportLib.getTallyExport({
      restaurantId,
      fromDate: "2026-05-01",
      toDate: "2026-05-31",
      branchId,
    });
    expect(scoped.voucherCount).toBe(1);
    expect(scoped.xml).not.toContain("Branch:");
  });

  it("skips (and reports) a voucher whose lines don't balance, rather than exporting broken XML", async () => {
    await setup();
    // Deliberately bypasses postVoucher() — the only way to construct an
    // unbalanced voucher (see Slice 7e's own health-check test for the
    // same technique).
    const [voucher] = await db
      .insert(schema.accountingVouchers)
      .values({
        restaurantId,
        branchId,
        voucherType: "journal",
        voucherNumber: "TEST-TALLY-UNBALANCED-0001",
        voucherDate: "2026-05-15",
        narration: "TEST deliberately unbalanced voucher",
      })
      .returning({ id: schema.accountingVouchers.id, voucherNumber: schema.accountingVouchers.voucherNumber });
    await db.insert(schema.accountingVoucherLines).values([
      { voucherId: voucher.id, accountId: cashAccountId, debitInPaisa: 1_000_00, creditInPaisa: 0 },
      { voucherId: voucher.id, accountId: salesRevenueAccountId, debitInPaisa: 0, creditInPaisa: 500_00 },
    ]);

    const result = await tallyExportLib.getTallyExport({ restaurantId, fromDate: "2026-05-01", toDate: "2026-05-31" });

    expect(result.voucherCount).toBe(0);
    expect(result.skippedVoucherNumbers).toEqual([voucher.voucherNumber]);
    expect(result.xml).not.toContain(voucher.voucherNumber);
  });

  it("returns a valid, empty envelope for a period with no activity", async () => {
    await setup();
    const result = await tallyExportLib.getTallyExport({ restaurantId, fromDate: "2020-01-01", toDate: "2020-01-31" });

    expect(result.voucherCount).toBe(0);
    expect(result.xml).toContain("<TALLYMESSAGE></TALLYMESSAGE>");
  });
});
