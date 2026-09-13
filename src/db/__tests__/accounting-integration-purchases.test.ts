/**
 * Integration tests for Phase 4, Slice 4c —
 * src/lib/accounting/integrations/purchases.ts (purchase posting, purchase
 * void reversal, the generic single-entry ledger due settlement, and the
 * lump-sum supplier/customer-credit settlement mirrors). See
 * ACCOUNTING_PHASE_4_PLAN.md and ACCOUNTING_POLICY_AND_POSTING_MATRIX.md §4.
 *
 * Skipped (not failed) when DATABASE_URL isn't set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Accounting — Slice 4c: purchases + supplier/customer settlement (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let chartOfAccountsLib: typeof import("@/lib/accounting/chart-of-accounts");
  let ledgerLib: typeof import("@/lib/ledger");
  let supplierDuesLib: typeof import("@/lib/supplier-dues");
  let purchasesLib: typeof import("@/lib/accounting/integrations/purchases");

  let restaurantId: string;
  let branchId: string;
  let userId: string;
  let supplierId: string;
  let customerId: string;
  let accountIdByCode: Map<string, string>;

  async function findAccountByCode(code: string) {
    const [row] = await db
      .select({ id: schema.chartOfAccounts.id })
      .from(schema.chartOfAccounts)
      .where(and(eq(schema.chartOfAccounts.restaurantId, restaurantId), eq(schema.chartOfAccounts.code, code)));
    return row.id;
  }

  async function makePurchase(params: { totalInPaisa: number; isCredit: boolean; supplierId?: string | null }) {
    const [purchase] = await db
      .insert(schema.purchases)
      .values({
        restaurantId,
        branchId,
        supplierId: params.supplierId ?? null,
        totalInPaisa: params.totalInPaisa,
        isCredit: params.isCredit,
      })
      .returning();
    return purchase;
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
    ledgerLib = await import("@/lib/ledger");
    supplierDuesLib = await import("@/lib/supplier-dues");
    purchasesLib = await import("@/lib/accounting/integrations/purchases");

    const suffix = Math.random().toString(36).slice(2, 8);
    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-acct-purchases-${suffix}`, name: "TEST Purchases Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;

    const [user] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Accountant 6", phone: `977${suffix}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    userId = user.id;

    const [supplier] = await db
      .insert(schema.suppliers)
      .values({ restaurantId, name: "TEST Supplier" })
      .returning({ id: schema.suppliers.id });
    supplierId = supplier.id;

    const [customer] = await db
      .insert(schema.customers)
      .values({ restaurantId, fullName: "TEST Customer", phone: `988${suffix}` })
      .returning({ id: schema.customers.id });
    customerId = customer.id;

    await db.transaction((tx) => chartOfAccountsLib.seedDefaultChartOfAccounts(tx, { restaurantId }));

    accountIdByCode = new Map();
    for (const code of ["1000", "1100", "1200", "2000"]) {
      accountIdByCode.set(code, await findAccountByCode(code));
    }
  });

  afterAll(async () => {
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  it("a cash purchase posts Dr Inventory / Cr Cash on Hand", async () => {
    const purchase = await makePurchase({ totalInPaisa: 500_00, isCredit: false });

    await db.transaction((tx) =>
      purchasesLib.postPurchaseVoucher(tx, {
        restaurantId,
        branchId,
        purchaseId: purchase.id,
        totalInPaisa: purchase.totalInPaisa,
        isCredit: false,
        supplierId: null,
        timezone: "Asia/Kathmandu",
        createdByUserId: userId,
      }),
    );

    const posted = await voucherLinesFor("purchase", purchase.id, "purchase");
    expect(posted).not.toBeNull();
    const inventoryId = accountIdByCode.get("1200")!;
    const cashId = accountIdByCode.get("1000")!;
    expect(posted!.lines.find((l) => l.accountId === inventoryId)?.debitInPaisa).toBe(500_00);
    expect(posted!.lines.find((l) => l.accountId === cashId)?.creditInPaisa).toBe(500_00);
  });

  it("a credit purchase posts Dr Inventory / Cr Accounts Payable, tagged to the supplier", async () => {
    const purchase = await makePurchase({ totalInPaisa: 800_00, isCredit: true, supplierId });

    await db.transaction((tx) =>
      purchasesLib.postPurchaseVoucher(tx, {
        restaurantId,
        branchId,
        purchaseId: purchase.id,
        totalInPaisa: purchase.totalInPaisa,
        isCredit: true,
        supplierId,
        timezone: "Asia/Kathmandu",
        createdByUserId: userId,
      }),
    );

    const posted = await voucherLinesFor("purchase", purchase.id, "purchase");
    const apId = accountIdByCode.get("2000")!;
    const apLine = posted!.lines.find((l) => l.accountId === apId);
    expect(apLine?.creditInPaisa).toBe(800_00);
    expect(apLine?.supplierId).toBe(supplierId);
  });

  it("voiding a purchase reverses its voucher, netting Inventory/Accounts Payable back to zero", async () => {
    const purchase = await makePurchase({ totalInPaisa: 300_00, isCredit: true, supplierId });
    await db.transaction((tx) =>
      ledgerLib.recordPurchaseLedgerEntry(tx, {
        restaurantId,
        purchaseId: purchase.id,
        totalInPaisa: purchase.totalInPaisa,
        timezone: "Asia/Kathmandu",
        markAsDue: true,
        recordedByUserId: userId,
        supplierId,
      }),
    );
    await db.transaction((tx) =>
      purchasesLib.postPurchaseVoucher(tx, {
        restaurantId,
        branchId,
        purchaseId: purchase.id,
        totalInPaisa: purchase.totalInPaisa,
        isCredit: true,
        supplierId,
        timezone: "Asia/Kathmandu",
        createdByUserId: userId,
      }),
    );

    await db.transaction((tx) =>
      supplierDuesLib.voidPurchase(tx, {
        restaurantId,
        purchaseId: purchase.id,
        voidedByUserId: userId,
        reason: "TEST — wrong delivery",
        timezone: "Asia/Kathmandu",
      }),
    );
    await db.transaction((tx) =>
      purchasesLib.reversePurchaseVoucher(tx, {
        restaurantId,
        purchaseId: purchase.id,
        reason: "TEST — wrong delivery",
        reversedByUserId: userId,
        timezone: "Asia/Kathmandu",
      }),
    );

    const original = await voucherLinesFor("purchase", purchase.id, "purchase");
    expect(original!.voucher.status).toBe("reversed");

    const inventoryId = accountIdByCode.get("1200")!;
    const apId = accountIdByCode.get("2000")!;

    // reverseVoucher() never edits the original — it posts a SEPARATE
    // voucher with every line swapped, then marks the original "reversed".
    // Net effect across the two, for each account, should be exactly zero.
    const reversalVoucher = await db
      .select()
      .from(schema.accountingVouchers)
      .where(eq(schema.accountingVouchers.reversalOfVoucherId, original!.voucher.id));
    expect(reversalVoucher).toHaveLength(1);
    const reversalLines = await db
      .select()
      .from(schema.accountingVoucherLines)
      .where(eq(schema.accountingVoucherLines.voucherId, reversalVoucher[0].id));

    const netFor = (accountId: string) =>
      [...original!.lines, ...reversalLines]
        .filter((l) => l.accountId === accountId)
        .reduce((s, l) => s + l.debitInPaisa - l.creditInPaisa, 0);
    expect(netFor(inventoryId)).toBe(0);
    expect(netFor(apId)).toBe(0);
  });

  it("settling a supplier due via the generic single-entry route posts Dr Accounts Payable / Cr Cash", async () => {
    const purchase = await makePurchase({ totalInPaisa: 400_00, isCredit: true, supplierId });
    const ledgerEntry = await db.transaction((tx) =>
      ledgerLib.recordPurchaseLedgerEntry(tx, {
        restaurantId,
        purchaseId: purchase.id,
        totalInPaisa: purchase.totalInPaisa,
        timezone: "Asia/Kathmandu",
        markAsDue: true,
        recordedByUserId: userId,
        supplierId,
      }),
    );

    const settled = await db.transaction((tx) =>
      ledgerLib.settleLedgerDue(tx, {
        restaurantId,
        entryId: ledgerEntry!.id,
        amountInPaisa: 400_00,
        timezone: "Asia/Kathmandu",
        recordedByUserId: userId,
      }),
    );
    await db.transaction((tx) =>
      purchasesLib.postLedgerDueSettlementVoucher(tx, {
        restaurantId,
        branchId,
        referenceType: settled.original.referenceType!,
        settlementEntryId: settled.settlementEntry.id,
        supplierId: settled.original.supplierId,
        customerId: settled.original.customerId,
        amountInPaisa: 400_00,
        timezone: "Asia/Kathmandu",
        createdByUserId: userId,
      }),
    );

    const settlement = await voucherLinesFor("ledger_due_settlement", settled.settlementEntry.id, "settled");
    expect(settlement).not.toBeNull();
    const apId = accountIdByCode.get("2000")!;
    const cashId = accountIdByCode.get("1000")!;
    expect(settlement!.lines.find((l) => l.accountId === apId)?.debitInPaisa).toBe(400_00);
    expect(settlement!.lines.find((l) => l.accountId === cashId)?.creditInPaisa).toBe(400_00);
  });

  it("settling a customer's order due via the generic single-entry route posts Dr Cash / Cr Accounts Receivable", async () => {
    const [order] = await db
      .insert(schema.orders)
      .values({
        restaurantId,
        branchId,
        orderNumber: `TEST-${Math.random().toString(36).slice(2, 8)}`,
        source: "pos",
        status: "completed",
        subtotalInPaisa: 600_00,
        taxInPaisa: 0,
        totalInPaisa: 600_00,
        paymentStatus: "unpaid",
        customerId,
      })
      .returning();
    const ledgerEntry = await db.transaction((tx) =>
      ledgerLib.recordSalesLedgerEntry(tx, {
        restaurantId,
        orderId: order.id,
        orderNumber: order.orderNumber,
        totalInPaisa: order.totalInPaisa,
        paymentStatus: "unpaid",
        timezone: "Asia/Kathmandu",
        recordedByUserId: userId,
        customerId,
      }),
    );

    const settled = await db.transaction((tx) =>
      ledgerLib.settleLedgerDue(tx, {
        restaurantId,
        entryId: ledgerEntry!.id,
        amountInPaisa: 600_00,
        timezone: "Asia/Kathmandu",
        recordedByUserId: userId,
      }),
    );
    await db.transaction((tx) =>
      purchasesLib.postLedgerDueSettlementVoucher(tx, {
        restaurantId,
        branchId,
        referenceType: settled.original.referenceType!,
        settlementEntryId: settled.settlementEntry.id,
        supplierId: settled.original.supplierId,
        customerId: settled.original.customerId,
        amountInPaisa: 600_00,
        timezone: "Asia/Kathmandu",
        createdByUserId: userId,
      }),
    );

    const settlement = await voucherLinesFor("ledger_due_settlement", settled.settlementEntry.id, "settled");
    expect(settlement).not.toBeNull();
    const arId = accountIdByCode.get("1100")!;
    const cashId = accountIdByCode.get("1000")!;
    expect(settlement!.lines.find((l) => l.accountId === cashId)?.debitInPaisa).toBe(600_00);
    const arLine = settlement!.lines.find((l) => l.accountId === arId);
    expect(arLine?.creditInPaisa).toBe(600_00);
    expect(arLine?.customerId).toBe(customerId);
  });

  it("a lump-sum supplier payment across two purchases posts one voucher for the total applied", async () => {
    const p1 = await makePurchase({ totalInPaisa: 200_00, isCredit: true, supplierId });
    const p2 = await makePurchase({ totalInPaisa: 300_00, isCredit: true, supplierId });
    await db.transaction((tx) =>
      ledgerLib.recordPurchaseLedgerEntry(tx, {
        restaurantId,
        purchaseId: p1.id,
        totalInPaisa: p1.totalInPaisa,
        timezone: "Asia/Kathmandu",
        markAsDue: true,
        recordedByUserId: userId,
        supplierId,
      }),
    );
    await db.transaction((tx) =>
      ledgerLib.recordPurchaseLedgerEntry(tx, {
        restaurantId,
        purchaseId: p2.id,
        totalInPaisa: p2.totalInPaisa,
        timezone: "Asia/Kathmandu",
        markAsDue: true,
        recordedByUserId: userId,
        supplierId,
      }),
    );

    const payment = await db.transaction((tx) =>
      ledgerLib.recordSupplierPayment(tx, {
        restaurantId,
        supplierId,
        amountInPaisa: 500_00,
        timezone: "Asia/Kathmandu",
        recordedByUserId: userId,
      }),
    );
    expect(payment.settlements).toHaveLength(2);

    await db.transaction((tx) =>
      purchasesLib.postSupplierPaymentVoucher(tx, {
        restaurantId,
        branchId,
        supplierId,
        firstSettlementEntryId: payment.settlements[0].settlementEntry.id,
        appliedInPaisa: payment.appliedInPaisa,
        timezone: "Asia/Kathmandu",
        createdByUserId: userId,
      }),
    );

    const voucher = await voucherLinesFor("supplier_payment", payment.settlements[0].settlementEntry.id, "settled");
    expect(voucher).not.toBeNull();
    const apId = accountIdByCode.get("2000")!;
    const cashId = accountIdByCode.get("1000")!;
    expect(voucher!.lines.find((l) => l.accountId === apId)?.debitInPaisa).toBe(500_00);
    expect(voucher!.lines.find((l) => l.accountId === cashId)?.creditInPaisa).toBe(500_00);
  });

  it("a lump-sum customer credit settlement posts one voucher for the total applied", async () => {
    const [order] = await db
      .insert(schema.orders)
      .values({
        restaurantId,
        branchId,
        orderNumber: `TEST-${Math.random().toString(36).slice(2, 8)}`,
        source: "pos",
        status: "completed",
        subtotalInPaisa: 700_00,
        taxInPaisa: 0,
        totalInPaisa: 700_00,
        paymentStatus: "unpaid",
        customerId,
      })
      .returning();
    await db.transaction((tx) =>
      ledgerLib.recordSalesLedgerEntry(tx, {
        restaurantId,
        orderId: order.id,
        orderNumber: order.orderNumber,
        totalInPaisa: order.totalInPaisa,
        paymentStatus: "unpaid",
        timezone: "Asia/Kathmandu",
        recordedByUserId: userId,
        customerId,
      }),
    );

    const settlement = await db.transaction((tx) =>
      ledgerLib.settleCustomerCredit(tx, {
        restaurantId,
        customerId,
        amountInPaisa: 700_00,
        timezone: "Asia/Kathmandu",
        recordedByUserId: userId,
      }),
    );

    await db.transaction((tx) =>
      purchasesLib.postCustomerCreditSettlementVoucher(tx, {
        restaurantId,
        branchId,
        customerId,
        firstSettlementEntryId: settlement.settlements[0].settlementEntry.id,
        appliedInPaisa: settlement.appliedInPaisa,
        timezone: "Asia/Kathmandu",
        createdByUserId: userId,
      }),
    );

    const voucher = await voucherLinesFor(
      "customer_credit_settlement",
      settlement.settlements[0].settlementEntry.id,
      "settled",
    );
    expect(voucher).not.toBeNull();
    const arId = accountIdByCode.get("1100")!;
    const cashId = accountIdByCode.get("1000")!;
    expect(voucher!.lines.find((l) => l.accountId === cashId)?.debitInPaisa).toBe(700_00);
    expect(voucher!.lines.find((l) => l.accountId === arId)?.creditInPaisa).toBe(700_00);
  });

  it("is idempotent — replaying the same purchase posting posts only one voucher", async () => {
    const purchase = await makePurchase({ totalInPaisa: 100_00, isCredit: false });
    const post = () =>
      db.transaction((tx) =>
        purchasesLib.postPurchaseVoucher(tx, {
          restaurantId,
          branchId,
          purchaseId: purchase.id,
          totalInPaisa: purchase.totalInPaisa,
          isCredit: false,
          supplierId: null,
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
          eq(schema.accountingVouchers.sourceId, purchase.id),
          eq(schema.accountingVouchers.postingEvent, "purchase"),
        ),
      );
    expect(allVouchers).toHaveLength(1);
  });
});
