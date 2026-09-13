/**
 * Integration tests for Phase 4, Slice 4e —
 * src/lib/accounting/integrations/payroll.ts (cash-basis payroll payout
 * posting and its one-way void reversal). See ACCOUNTING_PHASE_4_PLAN.md and
 * ACCOUNTING_POLICY_AND_POSTING_MATRIX.md §6.
 *
 * Skipped (not failed) when DATABASE_URL isn't set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Accounting — Slice 4e: payroll (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let chartOfAccountsLib: typeof import("@/lib/accounting/chart-of-accounts");
  let payrollLib: typeof import("@/lib/accounting/integrations/payroll");

  let restaurantId: string;
  let branchId: string;
  let userId: string;
  let userRoleId: string;
  let accountIdByCode: Map<string, string>;

  async function findAccountByCode(code: string) {
    const [row] = await db
      .select({ id: schema.chartOfAccounts.id })
      .from(schema.chartOfAccounts)
      .where(and(eq(schema.chartOfAccounts.restaurantId, restaurantId), eq(schema.chartOfAccounts.code, code)));
    return row.id;
  }

  let paymentCounter = 0;
  async function makePaidPayroll(params: { amountInPaisa: number; paymentMethod: string; payPeriodLabel?: string }) {
    paymentCounter += 1;
    const [payment] = await db
      .insert(schema.payrollPayments)
      .values({
        restaurantId,
        userRoleId,
        staffNameSnapshot: "TEST Staff Member Full Name",
        amountInPaisa: params.amountInPaisa,
        payPeriodLabel: params.payPeriodLabel ?? `TEST period ${paymentCounter}`,
        paymentMethod: params.paymentMethod as (typeof schema.expensePaymentMethodEnum.enumValues)[number],
      })
      .returning();
    return payment;
  }

  async function voucherLinesFor(sourceId: string, postingEvent: string) {
    const [voucher] = await db
      .select()
      .from(schema.accountingVouchers)
      .where(
        and(
          eq(schema.accountingVouchers.restaurantId, restaurantId),
          eq(schema.accountingVouchers.sourceType, "payroll_payout"),
          eq(schema.accountingVouchers.sourceId, sourceId),
          eq(schema.accountingVouchers.postingEvent, postingEvent),
        ),
      );
    if (!voucher) return null;
    const lines = await db
      .select()
      .from(schema.accountingVoucherLines)
      .where(eq(schema.accountingVoucherLines.voucherId, voucher.id));
    return { voucher, lines };
  }

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    chartOfAccountsLib = await import("@/lib/accounting/chart-of-accounts");
    payrollLib = await import("@/lib/accounting/integrations/payroll");

    const suffix = Math.random().toString(36).slice(2, 8);
    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-acct-payroll-${suffix}`, name: "TEST Payroll Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;

    const [user] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Staff Member Full Name", phone: `978${suffix}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    userId = user.id;

    const [userRole] = await db
      .insert(schema.userRoles)
      .values({ userId, restaurantId, branchId, role: "waiter" })
      .returning({ id: schema.userRoles.id });
    userRoleId = userRole.id;

    await db.transaction((tx) => chartOfAccountsLib.seedDefaultChartOfAccounts(tx, { restaurantId }));

    accountIdByCode = new Map();
    for (const code of ["1000", "1030", "1040", "5100"]) {
      accountIdByCode.set(code, await findAccountByCode(code));
    }
  });

  afterAll(async () => {
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  it("a cash payroll payout posts Dr Salary Expense / Cr Cash on Hand", async () => {
    const payment = await makePaidPayroll({ amountInPaisa: 25000_00, paymentMethod: "cash" });
    await db.transaction((tx) =>
      payrollLib.postPayrollVoucher(tx, {
        restaurantId,
        branchId,
        payrollPaymentId: payment.id,
        amountInPaisa: payment.amountInPaisa,
        payPeriodLabel: payment.payPeriodLabel,
        paymentMethod: "cash",
        timezone: "Asia/Kathmandu",
        createdByUserId: userId,
      }),
    );

    const posted = await voucherLinesFor(payment.id, "paid");
    expect(posted).not.toBeNull();
    const salaryId = accountIdByCode.get("5100")!;
    const cashId = accountIdByCode.get("1000")!;
    expect(posted!.lines.find((l) => l.accountId === salaryId)?.debitInPaisa).toBe(25000_00);
    expect(posted!.lines.find((l) => l.accountId === cashId)?.creditInPaisa).toBe(25000_00);
  });

  it("never puts the staff member's name in the voucher narration", async () => {
    const payment = await makePaidPayroll({
      amountInPaisa: 12000_00,
      paymentMethod: "cash",
      payPeriodLabel: "August 2026",
    });
    await db.transaction((tx) =>
      payrollLib.postPayrollVoucher(tx, {
        restaurantId,
        branchId,
        payrollPaymentId: payment.id,
        amountInPaisa: payment.amountInPaisa,
        payPeriodLabel: payment.payPeriodLabel,
        paymentMethod: "cash",
        timezone: "Asia/Kathmandu",
        createdByUserId: userId,
      }),
    );
    const posted = await voucherLinesFor(payment.id, "paid");
    expect(posted!.voucher.narration).toBe("Staff salary payment — August 2026");
    expect(posted!.voucher.narration).not.toContain("TEST Staff Member Full Name");
  });

  it("bank_transfer, eSewa, Khalti, and mobile banking payouts all share the Bank / Digital Payments account", async () => {
    const bankId = accountIdByCode.get("1040")!;
    for (const method of ["bank_transfer", "esewa", "khalti", "mobile_banking"] as const) {
      const payment = await makePaidPayroll({ amountInPaisa: 5000_00, paymentMethod: method });
      await db.transaction((tx) =>
        payrollLib.postPayrollVoucher(tx, {
          restaurantId,
          branchId,
          payrollPaymentId: payment.id,
          amountInPaisa: payment.amountInPaisa,
          payPeriodLabel: payment.payPeriodLabel,
          paymentMethod: method,
          timezone: "Asia/Kathmandu",
          createdByUserId: userId,
        }),
      );
      const posted = await voucherLinesFor(payment.id, "paid");
      expect(posted!.lines.find((l) => l.accountId === bankId)?.creditInPaisa).toBe(5000_00);
    }
  });

  it("an 'other'-method payout posts against Other Clearing", async () => {
    const payment = await makePaidPayroll({ amountInPaisa: 800_00, paymentMethod: "other" });
    await db.transaction((tx) =>
      payrollLib.postPayrollVoucher(tx, {
        restaurantId,
        branchId,
        payrollPaymentId: payment.id,
        amountInPaisa: payment.amountInPaisa,
        payPeriodLabel: payment.payPeriodLabel,
        paymentMethod: "other",
        timezone: "Asia/Kathmandu",
        createdByUserId: userId,
      }),
    );
    const otherId = accountIdByCode.get("1030")!;
    const posted = await voucherLinesFor(payment.id, "paid");
    expect(posted!.lines.find((l) => l.accountId === otherId)?.creditInPaisa).toBe(800_00);
  });

  it("voiding a paid payroll payment fully reverses its voucher (one-way — no un-void)", async () => {
    const payment = await makePaidPayroll({ amountInPaisa: 15000_00, paymentMethod: "cash" });
    await db.transaction((tx) =>
      payrollLib.postPayrollVoucher(tx, {
        restaurantId,
        branchId,
        payrollPaymentId: payment.id,
        amountInPaisa: payment.amountInPaisa,
        payPeriodLabel: payment.payPeriodLabel,
        paymentMethod: "cash",
        timezone: "Asia/Kathmandu",
        createdByUserId: userId,
      }),
    );
    const original = await voucherLinesFor(payment.id, "paid");
    const salaryId = accountIdByCode.get("5100")!;
    const cashId = accountIdByCode.get("1000")!;

    await db.transaction((tx) =>
      payrollLib.reversePayrollVoucher(tx, {
        restaurantId,
        payrollPaymentId: payment.id,
        reason: "TEST void",
        reversedByUserId: userId,
        timezone: "Asia/Kathmandu",
      }),
    );

    const afterVoid = await voucherLinesFor(payment.id, "paid");
    expect(afterVoid!.voucher.status).toBe("reversed");

    const [reversal] = await db
      .select()
      .from(schema.accountingVouchers)
      .where(eq(schema.accountingVouchers.reversalOfVoucherId, original!.voucher.id));
    expect(reversal).toBeDefined();
    const reversalLines = await db
      .select()
      .from(schema.accountingVoucherLines)
      .where(eq(schema.accountingVoucherLines.voucherId, reversal.id));

    const net = (accountId: string) =>
      [...original!.lines, ...reversalLines]
        .filter((l) => l.accountId === accountId)
        .reduce((s, l) => s + l.debitInPaisa - l.creditInPaisa, 0);
    expect(net(salaryId)).toBe(0);
    expect(net(cashId)).toBe(0);

    // Calling reversePayrollVoucher a second time hits postVoucher/
    // reverseVoucher's own "already reversed" guard on the ORIGINAL, so it
    // must not be re-callable in a way that reverses the reversal (there is
    // no un-void path for payroll, unlike expenses) — reverseVoucher()
    // looks up sourceType/sourceId/postingEvent === the ORIGINAL "paid"
    // voucher every time, and throws once that voucher is already reversed.
    await expect(
      db.transaction((tx) =>
        payrollLib.reversePayrollVoucher(tx, {
          restaurantId,
          payrollPaymentId: payment.id,
          reason: "TEST double void",
          reversedByUserId: userId,
          timezone: "Asia/Kathmandu",
        }),
      ),
    ).rejects.toThrow(/already been reversed/);
  });

  it("is idempotent — replaying the same payroll posting posts only one voucher", async () => {
    const payment = await makePaidPayroll({ amountInPaisa: 3000_00, paymentMethod: "cash" });
    const post = () =>
      db.transaction((tx) =>
        payrollLib.postPayrollVoucher(tx, {
          restaurantId,
          branchId,
          payrollPaymentId: payment.id,
          amountInPaisa: payment.amountInPaisa,
          payPeriodLabel: payment.payPeriodLabel,
          paymentMethod: "cash",
          timezone: "Asia/Kathmandu",
          createdByUserId: userId,
        }),
      );
    await post();
    await post();

    const allVouchers = await db
      .select()
      .from(schema.accountingVouchers)
      .where(
        and(
          eq(schema.accountingVouchers.restaurantId, restaurantId),
          eq(schema.accountingVouchers.sourceId, payment.id),
          eq(schema.accountingVouchers.postingEvent, "paid"),
        ),
      );
    expect(allVouchers).toHaveLength(1);
  });
});
