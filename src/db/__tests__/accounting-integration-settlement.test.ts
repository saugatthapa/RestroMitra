/**
 * Integration tests for Phase 4, Slice 4b —
 * src/lib/accounting/integrations/payment-settlement.ts (AR settlement +
 * refunds). See ACCOUNTING_PHASE_4_PLAN.md and
 * ACCOUNTING_POLICY_AND_POSTING_MATRIX.md §2. Same lib-level fixture
 * pattern as accounting-integration-sales.test.ts.
 *
 * Skipped (not failed) when DATABASE_URL isn't set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Accounting — Slice 4b: payment settlement + refunds (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let chartOfAccountsLib: typeof import("@/lib/accounting/chart-of-accounts");
  let orderCompletionLib: typeof import("@/lib/accounting/integrations/order-completion");
  let settlementLib: typeof import("@/lib/accounting/integrations/payment-settlement");

  let restaurantId: string;
  let branchId: string;
  let userId: string;
  let accountIdByCode: Map<string, string>;

  async function findAccountByCode(code: string) {
    const [row] = await db
      .select({ id: schema.chartOfAccounts.id })
      .from(schema.chartOfAccounts)
      .where(and(eq(schema.chartOfAccounts.restaurantId, restaurantId), eq(schema.chartOfAccounts.code, code)));
    return row.id;
  }

  async function makeCompletedOrder(params: { totalInPaisa: number; taxInPaisa?: number; customerId?: string | null }) {
    const suffix = Math.random().toString(36).slice(2, 8);
    const [order] = await db
      .insert(schema.orders)
      .values({
        restaurantId,
        branchId,
        orderNumber: `TEST-${suffix}`,
        source: "pos",
        status: "completed",
        subtotalInPaisa: params.totalInPaisa - (params.taxInPaisa ?? 0),
        taxInPaisa: params.taxInPaisa ?? 0,
        totalInPaisa: params.totalInPaisa,
        paymentStatus: "unpaid",
        customerId: params.customerId ?? null,
      })
      .returning();
    return order;
  }

  async function postSale(order: { id: string; orderNumber: string; subtotalInPaisa: number; discountInPaisa: number; serviceChargeInPaisa: number; taxInPaisa: number; totalInPaisa: number; customerId: string | null }) {
    await db.transaction((tx) =>
      orderCompletionLib.postSaleAndCogsVouchers(tx, {
        restaurantId,
        branchId,
        orderId: order.id,
        orderNumber: order.orderNumber,
        subtotalInPaisa: order.subtotalInPaisa,
        discountInPaisa: order.discountInPaisa,
        serviceChargeInPaisa: order.serviceChargeInPaisa,
        taxInPaisa: order.taxInPaisa,
        totalInPaisa: order.totalInPaisa,
        customerId: order.customerId,
        timezone: "Asia/Kathmandu",
        createdByUserId: userId,
      }),
    );
  }

  async function voucherLinesFor(sourceType: string, sourceId: string, postingEvent: string) {
    const [voucher] = await db
      .select()
      .from(schema.accountingVouchers)
      .where(
        and(
          eq(schema.accountingVouchers.restaurantId, restaurantId),
          eq(schema.accountingVouchers.sourceType, sourceType),
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
    orderCompletionLib = await import("@/lib/accounting/integrations/order-completion");
    settlementLib = await import("@/lib/accounting/integrations/payment-settlement");

    const suffix = Math.random().toString(36).slice(2, 8);
    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-acct-settlement-${suffix}`, name: "TEST Settlement Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;

    const [user] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Accountant 5", phone: `977${suffix}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    userId = user.id;

    await db.transaction((tx) => chartOfAccountsLib.seedDefaultChartOfAccounts(tx, { restaurantId }));

    accountIdByCode = new Map();
    for (const code of ["1000", "1010", "1100", "2100", "2200", "4910"]) {
      accountIdByCode.set(code, await findAccountByCode(code));
    }
  });

  afterAll(async () => {
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  it("settlement after a fully-on-credit order completes brings Accounts Receivable back to zero", async () => {
    const order = await makeCompletedOrder({ totalInPaisa: 500_00 });
    await postSale({ ...order, discountInPaisa: 0, serviceChargeInPaisa: 0, taxInPaisa: 0 });

    // Sale voucher booked the full 500 to AR (no payments at completion).
    const sale = await voucherLinesFor("order_completion", order.id, "sale");
    const arAccountId = accountIdByCode.get("1100")!;
    expect(sale!.lines.find((l) => l.accountId === arAccountId)?.debitInPaisa).toBe(500_00);

    // Customer pays the full 500 in cash after the fact.
    const [payment] = await db
      .insert(schema.payments)
      .values({ restaurantId, orderId: order.id, amountInPaisa: 500_00, method: "cash" })
      .returning();

    await db.transaction((tx) =>
      settlementLib.postPaymentSettlementVoucher(tx, {
        restaurantId,
        branchId,
        orderId: order.id,
        paymentId: payment.id,
        method: "cash",
        amountInPaisa: payment.amountInPaisa,
        tipInPaisa: payment.tipInPaisa,
        customerId: order.customerId,
        timezone: "Asia/Kathmandu",
        createdByUserId: userId,
      }),
    );

    const settlement = await voucherLinesFor("payment_settlement", payment.id, "settlement");
    expect(settlement).not.toBeNull();
    const totalDebit = settlement!.lines.reduce((s, l) => s + l.debitInPaisa, 0);
    const totalCredit = settlement!.lines.reduce((s, l) => s + l.creditInPaisa, 0);
    expect(totalDebit).toBe(totalCredit);
    expect(settlement!.lines.find((l) => l.accountId === accountIdByCode.get("1000"))?.debitInPaisa).toBe(500_00);
    expect(settlement!.lines.find((l) => l.accountId === arAccountId)?.creditInPaisa).toBe(500_00);

    // Net AR movement across both vouchers for this order: +500 (sale) - 500
    // (settlement) = 0 — the AR balance this customer's tab left behind is
    // fully cleared.
    const arLines = await db
      .select()
      .from(schema.accountingVoucherLines)
      .where(and(eq(schema.accountingVoucherLines.accountId, arAccountId), eq(schema.accountingVoucherLines.orderId, order.id)));
    const netAr = arLines.reduce((s, l) => s + l.debitInPaisa - l.creditInPaisa, 0);
    expect(netAr).toBe(0);
  });

  it("a settlement payment that also carries a tip splits correctly between AR and Tips Payable", async () => {
    const order = await makeCompletedOrder({ totalInPaisa: 300_00 });
    await postSale({ ...order, discountInPaisa: 0, serviceChargeInPaisa: 0, taxInPaisa: 0 });

    const [payment] = await db
      .insert(schema.payments)
      .values({ restaurantId, orderId: order.id, amountInPaisa: 300_00, tipInPaisa: 40_00, method: "card" })
      .returning();

    await db.transaction((tx) =>
      settlementLib.postPaymentSettlementVoucher(tx, {
        restaurantId,
        branchId,
        orderId: order.id,
        paymentId: payment.id,
        method: "card",
        amountInPaisa: payment.amountInPaisa,
        tipInPaisa: payment.tipInPaisa,
        customerId: order.customerId,
        timezone: "Asia/Kathmandu",
        createdByUserId: userId,
      }),
    );

    const settlement = await voucherLinesFor("payment_settlement", payment.id, "settlement");
    const cardAccountId = accountIdByCode.get("1010")!;
    const tipsAccountId = accountIdByCode.get("2200")!;
    expect(settlement!.lines.find((l) => l.accountId === cardAccountId)?.debitInPaisa).toBe(340_00);
    expect(settlement!.lines.find((l) => l.accountId === accountIdByCode.get("1100"))?.creditInPaisa).toBe(300_00);
    expect(settlement!.lines.find((l) => l.accountId === tipsAccountId)?.creditInPaisa).toBe(40_00);
  });

  it("a refund against a same-day cash sale books Sales Returns & Refunds against Cash", async () => {
    const order = await makeCompletedOrder({ totalInPaisa: 400_00 });
    await postSale({ ...order, discountInPaisa: 0, serviceChargeInPaisa: 0, taxInPaisa: 0 });
    await db.insert(schema.payments).values({ restaurantId, orderId: order.id, amountInPaisa: 400_00, method: "cash" });

    const [refund] = await db
      .insert(schema.payments)
      .values({ restaurantId, orderId: order.id, amountInPaisa: -150_00, method: "cash" })
      .returning();

    await db.transaction((tx) =>
      settlementLib.postRefundVoucher(tx, {
        restaurantId,
        branchId,
        orderId: order.id,
        refundPaymentId: refund.id,
        method: "cash",
        amountInPaisa: 150_00,
        orderTaxInPaisa: order.taxInPaisa,
        orderTotalInPaisa: order.totalInPaisa,
        timezone: "Asia/Kathmandu",
        createdByUserId: userId,
      }),
    );

    const refundVoucher = await voucherLinesFor("refund", refund.id, "refund");
    expect(refundVoucher).not.toBeNull();
    expect(refundVoucher!.voucher.voucherNumber).toMatch(/^RV-\d{6}$/);
    const returnsAccountId = accountIdByCode.get("4910")!;
    expect(refundVoucher!.lines.find((l) => l.accountId === returnsAccountId)?.debitInPaisa).toBe(150_00);
    expect(refundVoucher!.lines.find((l) => l.accountId === accountIdByCode.get("1000"))?.creditInPaisa).toBe(150_00);
  });

  it("a refund against a previous day's order is dated today, not backdated to the original sale", async () => {
    const order = await makeCompletedOrder({ totalInPaisa: 200_00 });
    await postSale({ ...order, discountInPaisa: 0, serviceChargeInPaisa: 0, taxInPaisa: 0 });

    const [refund] = await db
      .insert(schema.payments)
      .values({ restaurantId, orderId: order.id, amountInPaisa: -200_00, method: "cash" })
      .returning();

    await db.transaction((tx) =>
      settlementLib.postRefundVoucher(tx, {
        restaurantId,
        branchId,
        orderId: order.id,
        refundPaymentId: refund.id,
        method: "cash",
        amountInPaisa: 200_00,
        orderTaxInPaisa: order.taxInPaisa,
        orderTotalInPaisa: order.totalInPaisa,
        timezone: "Asia/Kathmandu",
        createdByUserId: userId,
      }),
    );

    const refundVoucher = await voucherLinesFor("refund", refund.id, "refund");
    const todayInKathmandu = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kathmandu" });
    expect(refundVoucher!.voucher.voucherDate).toBe(todayInKathmandu);
  });

  it("Phase 6, Slice 6d — a FULL refund of a taxed order reduces Tax Payable by exactly the order's own tax, with the rest to Sales Returns & Refunds", async () => {
    // 1000 subtotal + 130 tax (13%) = 1130 total.
    const order = await makeCompletedOrder({ totalInPaisa: 1_130_00, taxInPaisa: 130_00 });
    await postSale({ ...order, discountInPaisa: 0, serviceChargeInPaisa: 0 });
    await db.insert(schema.payments).values({ restaurantId, orderId: order.id, amountInPaisa: 1_130_00, method: "cash" });

    const [refund] = await db
      .insert(schema.payments)
      .values({ restaurantId, orderId: order.id, amountInPaisa: -1_130_00, method: "cash" })
      .returning();

    await db.transaction((tx) =>
      settlementLib.postRefundVoucher(tx, {
        restaurantId,
        branchId,
        orderId: order.id,
        refundPaymentId: refund.id,
        method: "cash",
        amountInPaisa: 1_130_00,
        orderTaxInPaisa: order.taxInPaisa,
        orderTotalInPaisa: order.totalInPaisa,
        timezone: "Asia/Kathmandu",
        createdByUserId: userId,
      }),
    );

    const refundVoucher = await voucherLinesFor("refund", refund.id, "refund");
    expect(refundVoucher).not.toBeNull();
    const returnsAccountId = accountIdByCode.get("4910")!;
    const taxPayableAccountId = accountIdByCode.get("2100")!;
    const cashAccountId = accountIdByCode.get("1000")!;
    expect(refundVoucher!.lines.find((l) => l.accountId === returnsAccountId)?.debitInPaisa).toBe(1_000_00);
    expect(refundVoucher!.lines.find((l) => l.accountId === taxPayableAccountId)?.debitInPaisa).toBe(130_00);
    expect(refundVoucher!.lines.find((l) => l.accountId === cashAccountId)?.creditInPaisa).toBe(1_130_00);
    const totalDebit = refundVoucher!.lines.reduce((s, l) => s + l.debitInPaisa, 0);
    const totalCredit = refundVoucher!.lines.reduce((s, l) => s + l.creditInPaisa, 0);
    expect(totalDebit).toBe(totalCredit);
  });

  it("Phase 6, Slice 6d — a PARTIAL refund of a taxed order prorates the tax portion by the order's own blended tax-to-total ratio", async () => {
    // 1000 subtotal + 130 tax (13%) = 1130 total. A 565 partial refund (half
    // the order) should carry exactly half the tax: 65.
    const order = await makeCompletedOrder({ totalInPaisa: 1_130_00, taxInPaisa: 130_00 });
    await postSale({ ...order, discountInPaisa: 0, serviceChargeInPaisa: 0 });
    await db.insert(schema.payments).values({ restaurantId, orderId: order.id, amountInPaisa: 1_130_00, method: "cash" });

    const [refund] = await db
      .insert(schema.payments)
      .values({ restaurantId, orderId: order.id, amountInPaisa: -565_00, method: "cash" })
      .returning();

    await db.transaction((tx) =>
      settlementLib.postRefundVoucher(tx, {
        restaurantId,
        branchId,
        orderId: order.id,
        refundPaymentId: refund.id,
        method: "cash",
        amountInPaisa: 565_00,
        orderTaxInPaisa: order.taxInPaisa,
        orderTotalInPaisa: order.totalInPaisa,
        timezone: "Asia/Kathmandu",
        createdByUserId: userId,
      }),
    );

    const refundVoucher = await voucherLinesFor("refund", refund.id, "refund");
    const returnsAccountId = accountIdByCode.get("4910")!;
    const taxPayableAccountId = accountIdByCode.get("2100")!;
    expect(refundVoucher!.lines.find((l) => l.accountId === returnsAccountId)?.debitInPaisa).toBe(500_00);
    expect(refundVoucher!.lines.find((l) => l.accountId === taxPayableAccountId)?.debitInPaisa).toBe(65_00);
  });

  it("Phase 6, Slice 6d — a refund of a tax-free order is unaffected: full amount to Sales Returns & Refunds, no Tax Payable line", async () => {
    const order = await makeCompletedOrder({ totalInPaisa: 250_00 });
    await postSale({ ...order, discountInPaisa: 0, serviceChargeInPaisa: 0, taxInPaisa: 0 });
    await db.insert(schema.payments).values({ restaurantId, orderId: order.id, amountInPaisa: 250_00, method: "cash" });

    const [refund] = await db
      .insert(schema.payments)
      .values({ restaurantId, orderId: order.id, amountInPaisa: -250_00, method: "cash" })
      .returning();

    await db.transaction((tx) =>
      settlementLib.postRefundVoucher(tx, {
        restaurantId,
        branchId,
        orderId: order.id,
        refundPaymentId: refund.id,
        method: "cash",
        amountInPaisa: 250_00,
        orderTaxInPaisa: order.taxInPaisa,
        orderTotalInPaisa: order.totalInPaisa,
        timezone: "Asia/Kathmandu",
        createdByUserId: userId,
      }),
    );

    const refundVoucher = await voucherLinesFor("refund", refund.id, "refund");
    const returnsAccountId = accountIdByCode.get("4910")!;
    const taxPayableAccountId = accountIdByCode.get("2100")!;
    expect(refundVoucher!.lines.find((l) => l.accountId === returnsAccountId)?.debitInPaisa).toBe(250_00);
    expect(refundVoucher!.lines.find((l) => l.accountId === taxPayableAccountId)).toBeUndefined();
  });

  it("is idempotent — replaying the same settlement or refund posts only one voucher each", async () => {
    const order = await makeCompletedOrder({ totalInPaisa: 100_00 });
    await postSale({ ...order, discountInPaisa: 0, serviceChargeInPaisa: 0, taxInPaisa: 0 });

    const [payment] = await db
      .insert(schema.payments)
      .values({ restaurantId, orderId: order.id, amountInPaisa: 100_00, method: "cash" })
      .returning();

    const settleOnce = () =>
      db.transaction((tx) =>
        settlementLib.postPaymentSettlementVoucher(tx, {
          restaurantId,
          branchId,
          orderId: order.id,
          paymentId: payment.id,
          method: "cash",
          amountInPaisa: payment.amountInPaisa,
          tipInPaisa: payment.tipInPaisa,
          customerId: order.customerId,
          timezone: "Asia/Kathmandu",
          createdByUserId: userId,
        }),
      );
    await settleOnce();
    await settleOnce();

    const allSettlementVouchers = await db
      .select()
      .from(schema.accountingVouchers)
      .where(
        and(
          eq(schema.accountingVouchers.restaurantId, restaurantId),
          eq(schema.accountingVouchers.sourceId, payment.id),
          eq(schema.accountingVouchers.postingEvent, "settlement"),
        ),
      );
    expect(allSettlementVouchers).toHaveLength(1);
  });
});
