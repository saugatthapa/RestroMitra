/**
 * Integration tests for Phase 4, Slice 4a —
 * src/lib/accounting/integrations/order-completion.ts, the automatic Sales
 * + Cost of Goods Sold posting fired at order completion. See
 * ACCOUNTING_PHASE_4_PLAN.md and ACCOUNTING_POLICY_AND_POSTING_MATRIX.md
 * §1/§6. Tests call postSaleAndCogsVouchers directly against real
 * order/payment/orderItem fixtures — the same lib-level pattern as
 * accounting-posting.test.ts — rather than driving the full HTTP status
 * route, since the route's own gating (isAutomaticPostingEnabled) is a
 * one-line check verified by inspection/tsc and a live smoke test, and the
 * actual risk surface worth real test coverage is the posting math itself.
 *
 * Skipped (not failed) when DATABASE_URL isn't set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Accounting — Slice 4a: sale + COGS posting (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let chartOfAccountsLib: typeof import("@/lib/accounting/chart-of-accounts");
  let mappingKeysLib: typeof import("@/lib/accounting/account-mapping-keys");
  let mappingsLib: typeof import("@/lib/accounting/account-mappings");
  let orderCompletionLib: typeof import("@/lib/accounting/integrations/order-completion");

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

  async function makeOrder(overrides: {
    subtotalInPaisa: number;
    discountInPaisa?: number;
    serviceChargeInPaisa?: number;
    taxInPaisa?: number;
    totalInPaisa: number;
    customerId?: string | null;
  }) {
    const suffix = Math.random().toString(36).slice(2, 8);
    const [order] = await db
      .insert(schema.orders)
      .values({
        restaurantId,
        branchId,
        orderNumber: `TEST-${suffix}`,
        source: "pos",
        status: "completed",
        subtotalInPaisa: overrides.subtotalInPaisa,
        discountInPaisa: overrides.discountInPaisa ?? 0,
        serviceChargeInPaisa: overrides.serviceChargeInPaisa ?? 0,
        taxInPaisa: overrides.taxInPaisa ?? 0,
        totalInPaisa: overrides.totalInPaisa,
        paymentStatus: "unpaid",
        customerId: overrides.customerId ?? null,
      })
      .returning();
    return order;
  }

  async function addPayment(orderId: string, params: { method: "cash" | "card" | "mobile_wallet" | "other"; amountInPaisa: number; tipInPaisa?: number }) {
    await db.insert(schema.payments).values({
      restaurantId,
      orderId,
      amountInPaisa: params.amountInPaisa,
      method: params.method,
      tipInPaisa: params.tipInPaisa ?? 0,
    });
  }

  async function voucherLinesFor(orderId: string, postingEvent: string) {
    const [voucher] = await db
      .select()
      .from(schema.accountingVouchers)
      .where(
        and(
          eq(schema.accountingVouchers.restaurantId, restaurantId),
          eq(schema.accountingVouchers.sourceType, "order_completion"),
          eq(schema.accountingVouchers.sourceId, orderId),
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
    mappingKeysLib = await import("@/lib/accounting/account-mapping-keys");
    mappingsLib = await import("@/lib/accounting/account-mappings");
    orderCompletionLib = await import("@/lib/accounting/integrations/order-completion");

    const suffix = Math.random().toString(36).slice(2, 8);
    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-acct-sales-${suffix}`, name: "TEST Sales Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;

    const [user] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Accountant 4", phone: `976${suffix}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    userId = user.id;

    await db.transaction((tx) => chartOfAccountsLib.seedDefaultChartOfAccounts(tx, { restaurantId }));

    accountIdByCode = new Map();
    for (const code of ["1000", "1010", "1100", "1200", "4000", "4900", "5000"]) {
      accountIdByCode.set(code, await findAccountByCode(code));
    }
  });

  afterAll(async () => {
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  it("cash-only order: Dr Cash, Cr Sales Revenue, balanced", async () => {
    const order = await makeOrder({ subtotalInPaisa: 1000_00, totalInPaisa: 1000_00 });
    await addPayment(order.id, { method: "cash", amountInPaisa: 1000_00 });

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

    const sale = await voucherLinesFor(order.id, "sale");
    expect(sale).not.toBeNull();
    expect(sale!.voucher.voucherNumber).toMatch(/^SV-\d{6}$/);
    const totalDebit = sale!.lines.reduce((s, l) => s + l.debitInPaisa, 0);
    const totalCredit = sale!.lines.reduce((s, l) => s + l.creditInPaisa, 0);
    expect(totalDebit).toBe(totalCredit);
    expect(totalDebit).toBe(1000_00);

    const cashLine = sale!.lines.find((l) => l.accountId === accountIdByCode.get("1000"));
    expect(cashLine?.debitInPaisa).toBe(1000_00);
    const salesLine = sale!.lines.find((l) => l.accountId === accountIdByCode.get("4000"));
    expect(salesLine?.creditInPaisa).toBe(1000_00);
  });

  it("split cash+card payment: two Dr clearing lines, still balanced", async () => {
    const order = await makeOrder({ subtotalInPaisa: 800_00, totalInPaisa: 800_00 });
    await addPayment(order.id, { method: "cash", amountInPaisa: 300_00 });
    await addPayment(order.id, { method: "card", amountInPaisa: 500_00 });

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

    const sale = await voucherLinesFor(order.id, "sale");
    expect(sale!.lines).toHaveLength(3); // cash, card, sales revenue
    const cashLine = sale!.lines.find((l) => l.accountId === accountIdByCode.get("1000"));
    const cardLine = sale!.lines.find((l) => l.accountId === accountIdByCode.get("1010"));
    expect(cashLine?.debitInPaisa).toBe(300_00);
    expect(cardLine?.debitInPaisa).toBe(500_00);
  });

  it("fully-on-credit order (zero payments): single Dr to Accounts Receivable", async () => {
    const order = await makeOrder({ subtotalInPaisa: 650_00, totalInPaisa: 650_00 });

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

    const sale = await voucherLinesFor(order.id, "sale");
    expect(sale!.lines).toHaveLength(2); // AR, sales revenue — no clearing line at all
    const arAccountId = await findAccountByCode("1100");
    const arLine = sale!.lines.find((l) => l.accountId === arAccountId);
    expect(arLine?.debitInPaisa).toBe(650_00);
  });

  it("order with a discount: Dr Discounts & Allowances, Cr Sales Revenue at the GROSS subtotal", async () => {
    // Gross subtotal 1000, discount 100 -> net 900, no tax/service charge.
    const order = await makeOrder({ subtotalInPaisa: 1000_00, discountInPaisa: 100_00, totalInPaisa: 900_00 });
    await addPayment(order.id, { method: "cash", amountInPaisa: 900_00 });

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

    const sale = await voucherLinesFor(order.id, "sale");
    const totalDebit = sale!.lines.reduce((s, l) => s + l.debitInPaisa, 0);
    const totalCredit = sale!.lines.reduce((s, l) => s + l.creditInPaisa, 0);
    expect(totalDebit).toBe(totalCredit);

    const discountAccountId = await findAccountByCode("4900");
    const discountLine = sale!.lines.find((l) => l.accountId === discountAccountId);
    expect(discountLine?.debitInPaisa).toBe(100_00);
    const salesLine = sale!.lines.find((l) => l.accountId === accountIdByCode.get("4000"));
    expect(salesLine?.creditInPaisa).toBe(1000_00); // gross, not net
  });

  it("order with a tip: the FULL amount (bill + tip) hits the clearing account, tip credits Tips Payable", async () => {
    // Rs 450 bill + Rs 50 tip, paid Rs 500 cash in one payment row.
    const order = await makeOrder({ subtotalInPaisa: 450_00, totalInPaisa: 450_00 });
    await addPayment(order.id, { method: "cash", amountInPaisa: 450_00, tipInPaisa: 50_00 });

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

    const sale = await voucherLinesFor(order.id, "sale");
    const totalDebit = sale!.lines.reduce((s, l) => s + l.debitInPaisa, 0);
    const totalCredit = sale!.lines.reduce((s, l) => s + l.creditInPaisa, 0);
    expect(totalDebit).toBe(totalCredit);
    expect(totalDebit).toBe(500_00); // 450 bill + 50 tip, physically in the drawer

    const cashLine = sale!.lines.find((l) => l.accountId === accountIdByCode.get("1000"));
    expect(cashLine?.debitInPaisa).toBe(500_00);
    const tipsAccountId = await findAccountByCode("2200");
    const tipsLine = sale!.lines.find((l) => l.accountId === tipsAccountId);
    expect(tipsLine?.creditInPaisa).toBe(50_00);
  });

  it("order with recipe-costed items: a separate, balanced COGS voucher posts alongside the sale", async () => {
    const order = await makeOrder({ subtotalInPaisa: 500_00, totalInPaisa: 500_00 });
    await addPayment(order.id, { method: "cash", amountInPaisa: 500_00 });
    await db.insert(schema.orderItems).values([
      {
        orderId: order.id,
        menuItemNameSnapshot: "TEST Dish",
        quantity: 1,
        unitPriceInPaisa: 500_00,
        lineSubtotalInPaisa: 500_00,
        lineTotalInPaisa: 500_00,
        recipeCostInPaisa: 180_00,
      },
    ]);

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

    const cogs = await voucherLinesFor(order.id, "cogs");
    expect(cogs).not.toBeNull();
    const totalDebit = cogs!.lines.reduce((s, l) => s + l.debitInPaisa, 0);
    const totalCredit = cogs!.lines.reduce((s, l) => s + l.creditInPaisa, 0);
    expect(totalDebit).toBe(totalCredit);
    expect(totalDebit).toBe(180_00);

    const cogsAccountId = await findAccountByCode("5000");
    const inventoryAccountId = await findAccountByCode("1200");
    expect(cogs!.lines.find((l) => l.accountId === cogsAccountId)?.debitInPaisa).toBe(180_00);
    expect(cogs!.lines.find((l) => l.accountId === inventoryAccountId)?.creditInPaisa).toBe(180_00);
  });

  it("is idempotent — calling twice for the same order posts only one sale voucher", async () => {
    const order = await makeOrder({ subtotalInPaisa: 200_00, totalInPaisa: 200_00 });
    await addPayment(order.id, { method: "cash", amountInPaisa: 200_00 });

    const call = () =>
      db.transaction((tx) =>
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

    await call();
    await call();

    const allSaleVouchers = await db
      .select()
      .from(schema.accountingVouchers)
      .where(
        and(
          eq(schema.accountingVouchers.restaurantId, restaurantId),
          eq(schema.accountingVouchers.sourceId, order.id),
          eq(schema.accountingVouchers.postingEvent, "sale"),
        ),
      );
    expect(allSaleVouchers).toHaveLength(1);
  });

  it("resolveAccountMappings throws a clear error when a mapping is missing", async () => {
    await expect(
      db.transaction((tx) =>
        mappingsLib.resolveAccountMappings(tx, {
          restaurantId,
          keys: ["control:not_a_real_mapping" as unknown as (typeof mappingKeysLib.MAPPING_KEYS)[keyof typeof mappingKeysLib.MAPPING_KEYS]],
        }),
      ),
    ).rejects.toThrow(/no account is mapped/i);
  });

  it("resolveAccountMappings throws when the mapped account has been deactivated", async () => {
    const cashAccountId = accountIdByCode.get("1000")!;
    await db.update(schema.chartOfAccounts).set({ isActive: false }).where(eq(schema.chartOfAccounts.id, cashAccountId));

    await expect(
      db.transaction((tx) =>
        mappingsLib.resolveAccountMappings(tx, {
          restaurantId,
          keys: [mappingKeysLib.MAPPING_KEYS.PAYMENT_METHOD_CASH],
        }),
      ),
    ).rejects.toThrow(/deactivated/i);

    // Restore for any later test in this file that relies on Cash on Hand.
    await db.update(schema.chartOfAccounts).set({ isActive: true }).where(eq(schema.chartOfAccounts.id, cashAccountId));
  });
});
