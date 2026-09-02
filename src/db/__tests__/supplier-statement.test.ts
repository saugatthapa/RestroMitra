/**
 * Gap Audit P1 (Supplier Statement) integration tests for
 * getSupplierStatement (src/lib/supplier-statement.ts) and the
 * recordSupplierPayment/recordSupplierAdjustment additions to
 * src/lib/ledger.ts.
 *
 * Same convention as supplier-dues.test.ts/customer-credit.test.ts (see
 * their own doc comments): RBAC/tenant scoping for
 * resolveRestaurantContext() is covered elsewhere, so this file exercises
 * the business logic directly — running-balance math, date-range slicing,
 * cash-purchase/void exclusion, FIFO payment allocation, adjustment sign
 * convention, tenant isolation, and — the load-bearing assertion this
 * whole feature exists for — that the statement's closing balance
 * reconciles EXACTLY with getSupplierDueReport's already-trusted
 * point-in-time outstanding figure.
 *
 * Skipped (not failed) when DATABASE_URL isn't set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { recordStockMovement } from "@/lib/inventory";

const hasDb = Boolean(process.env.DATABASE_URL);
const TZ = "UTC";

describe.skipIf(!hasDb)("Supplier Statement (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let ledger: typeof import("@/lib/ledger");
  let supplierDues: typeof import("@/lib/supplier-dues");
  let supplierStatement: typeof import("@/lib/supplier-statement");

  let ownerId: string;
  let restaurantId: string;
  let otherRestaurantId: string;
  let branchId: string;
  let inventoryItemId: string;
  let otherSupplierId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    ledger = await import("@/lib/ledger");
    supplierDues = await import("@/lib/supplier-dues");
    supplierStatement = await import("@/lib/supplier-statement");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [owner] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Statement Owner", phone: `972${suffix}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    ownerId = owner.id;

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-supplier-stmt-${suffix}`, name: "TEST Supplier Statement Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [otherRestaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-supplier-stmt-other-${suffix}`, name: "TEST Other Restaurant" })
      .returning({ id: schema.restaurants.id });
    otherRestaurantId = otherRestaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;

    const [inventoryItem] = await db
      .insert(schema.inventoryItems)
      .values({ restaurantId, name: "TEST Statement Rice", unit: "kg", costPerUnitInPaisa: 0, currentStockMilliunits: 0 })
      .returning({ id: schema.inventoryItems.id });
    inventoryItemId = inventoryItem.id;

    const [otherSupplier] = await db
      .insert(schema.suppliers)
      .values({ restaurantId: otherRestaurantId, name: "TEST Other Restaurant Supplier" })
      .returning({ id: schema.suppliers.id });
    otherSupplierId = otherSupplier.id;
  });

  afterAll(async () => {
    await db.delete(schema.purchases).where(eq(schema.purchases.restaurantId, restaurantId));
    await db.delete(schema.ledgerEntries).where(eq(schema.ledgerEntries.restaurantId, restaurantId));
    await db.delete(schema.ledgerEntries).where(eq(schema.ledgerEntries.restaurantId, otherRestaurantId));
    await db.delete(schema.inventoryItems).where(eq(schema.inventoryItems.restaurantId, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, otherRestaurantId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerId));
  });

  async function createSupplier(name: string) {
    const [supplier] = await db.insert(schema.suppliers).values({ restaurantId, name }).returning();
    return supplier;
  }

  /** Mirrors what the purchases POST route does (real purchases/purchase_items rows), minus HTTP/session plumbing. */
  async function createPurchase(opts: {
    supplierId: string;
    totalInPaisa: number;
    isCredit: boolean;
    dueDate?: string | null;
  }) {
    return db.transaction(async (tx) => {
      const [purchase] = await tx
        .insert(schema.purchases)
        .values({
          restaurantId,
          branchId,
          supplierId: opts.supplierId,
          totalInPaisa: opts.totalInPaisa,
          isCredit: opts.isCredit,
          dueDate: opts.isCredit ? opts.dueDate ?? null : null,
          recordedByUserId: ownerId,
        })
        .returning();

      await tx.insert(schema.purchaseItems).values({
        purchaseId: purchase.id,
        inventoryItemId,
        quantityMilliunits: 1_000,
        unitCostInPaisa: opts.totalInPaisa,
        lineTotalInPaisa: opts.totalInPaisa,
      });
      await recordStockMovement(tx, {
        restaurantId,
        branchId,
        inventoryItemId,
        type: "purchase",
        quantityDeltaMilliunits: 1_000,
        referenceType: "purchase",
        referenceId: purchase.id,
        recordedByUserId: ownerId,
      });

      const ledgerEntry = await ledger.recordPurchaseLedgerEntry(tx, {
        restaurantId,
        purchaseId: purchase.id,
        totalInPaisa: opts.totalInPaisa,
        supplierName: null,
        invoiceNumber: null,
        timezone: TZ,
        markAsDue: opts.isCredit,
        recordedByUserId: ownerId,
        supplierId: opts.supplierId,
      });

      return { purchase, ledgerEntry: ledgerEntry! };
    });
  }

  /** Directly-dated purchase-category ledger line, for controlling entryDate in running-balance tests. */
  function purchaseLine(supplierId: string, amountInPaisa: number, entryDate: string) {
    return db.transaction((tx) =>
      ledger.recordLedgerEntry(tx, {
        restaurantId,
        direction: "debit",
        category: "purchase",
        amountInPaisa,
        entryDate,
        timezone: TZ,
        description: "TEST dated purchase",
        referenceType: "purchase",
        markAsDue: true,
        recordedByUserId: ownerId,
        supplierId,
      }),
    );
  }

  /** Directly-dated due_settlement-category ledger line — same shape settleLedgerDue produces. */
  function paymentLine(supplierId: string, amountInPaisa: number, entryDate: string) {
    return db.transaction((tx) =>
      ledger.recordLedgerEntry(tx, {
        restaurantId,
        direction: "debit",
        category: "due_settlement",
        amountInPaisa,
        entryDate,
        timezone: TZ,
        description: "TEST dated payment",
        referenceType: "due_settlement",
        recordedByUserId: ownerId,
        supplierId,
      }),
    );
  }

  it("reconciliation: statement's closing balance (no range) exactly matches getSupplierDueReport's outstanding total for the same supplier", async () => {
    const supplier = await createSupplier("TEST Reconciliation Supplier");

    // Fully outstanding.
    await createPurchase({ supplierId: supplier.id, totalInPaisa: 10_000, isCredit: true });
    // Partially settled.
    const partial = await createPurchase({ supplierId: supplier.id, totalInPaisa: 8_000, isCredit: true });
    await db.transaction((tx) =>
      ledger.settleLedgerDue(tx, {
        restaurantId,
        entryId: partial.ledgerEntry.id,
        amountInPaisa: 3_000,
        timezone: TZ,
        recordedByUserId: ownerId,
      }),
    );
    // Fully settled — must contribute zero to both figures.
    const full = await createPurchase({ supplierId: supplier.id, totalInPaisa: 6_000, isCredit: true });
    await db.transaction((tx) =>
      ledger.settleLedgerDue(tx, {
        restaurantId,
        entryId: full.ledgerEntry.id,
        amountInPaisa: 6_000,
        timezone: TZ,
        recordedByUserId: ownerId,
      }),
    );
    // Cash purchase — paid in full at the register, must never count as a due.
    await createPurchase({ supplierId: supplier.id, totalInPaisa: 4_000, isCredit: false });
    // Voided credit purchase (never settled, so voidable) — must be excluded from both figures.
    const voided = await createPurchase({ supplierId: supplier.id, totalInPaisa: 2_500, isCredit: true });
    await db.transaction((tx) =>
      supplierDues.voidPurchase(tx, {
        restaurantId,
        purchaseId: voided.purchase.id,
        voidedByUserId: ownerId,
        reason: "TEST void",
        timezone: TZ,
      }),
    );

    const report = await supplierDues.getSupplierDueReport(restaurantId, TZ, { supplierId: supplier.id });
    const statement = await supplierStatement.getSupplierStatement(restaurantId, supplier.id, TZ);

    // 10,000 outstanding + (8,000 - 3,000) partially settled = 15,000.
    expect(report.totalDueInPaisa).toBe(15_000);
    expect(statement.closingBalanceInPaisa).toBe(report.totalDueInPaisa);
    expect(statement.openingBalanceInPaisa).toBe(0); // no `from` supplied — everything is "in range"
  });

  it("running balance: a realistic chronological sequence of purchases/payments/adjustments produces the correct opening, per-line, and closing balances", async () => {
    const supplier = await createSupplier("TEST Running Balance Supplier");

    const D0 = "2025-01-01"; // before the requested range — folds into opening balance only
    const FROM = "2025-02-01"; // range start
    const D2 = "2025-02-10";
    const D3 = "2025-02-15";
    const D4 = "2025-02-20";
    const D4B = "2025-02-21";
    const TO = "2025-02-28"; // range end
    const AFTER_TO = "2025-03-05"; // strictly after `to` — must never appear

    await purchaseLine(supplier.id, 10_000, D0);
    await paymentLine(supplier.id, 4_000, D0);
    // Opening balance as of FROM = 10,000 - 4,000 = 6,000.

    await purchaseLine(supplier.id, 5_000, FROM); // running: 11,000
    await purchaseLine(supplier.id, 3_000, D2); // running: 14,000
    await paymentLine(supplier.id, 5_000, D3); // running: 9,000
    await db.transaction((tx) =>
      ledger.recordSupplierAdjustment(tx, {
        restaurantId,
        supplierId: supplier.id,
        direction: "debit",
        amountInPaisa: 1_000,
        description: "TEST debit note",
        entryDate: D4,
        timezone: TZ,
        recordedByUserId: ownerId,
      }),
    ); // running: 10,000
    await db.transaction((tx) =>
      ledger.recordSupplierAdjustment(tx, {
        restaurantId,
        supplierId: supplier.id,
        direction: "credit",
        amountInPaisa: 500,
        description: "TEST credit note",
        entryDate: D4B,
        timezone: TZ,
        recordedByUserId: ownerId,
      }),
    ); // running: 9,500

    // Outside the [FROM, TO] range entirely — must not affect opening,
    // in-range lines, or closing.
    await purchaseLine(supplier.id, 9_999, AFTER_TO);

    const statement = await supplierStatement.getSupplierStatement(restaurantId, supplier.id, TZ, {
      from: FROM,
      to: TO,
    });

    expect(statement.openingBalanceInPaisa).toBe(6_000);
    expect(statement.lines.map((l) => [l.type, l.deltaInPaisa, l.runningBalanceInPaisa])).toEqual([
      ["purchase", 5_000, 11_000],
      ["purchase", 3_000, 14_000],
      ["payment", -5_000, 9_000],
      ["adjustment", 1_000, 10_000],
      ["adjustment", -500, 9_500],
    ]);
    expect(statement.closingBalanceInPaisa).toBe(9_500);
    expect(statement.totalPurchasesInPaisa).toBe(8_000);
    expect(statement.totalPaymentsInPaisa).toBe(5_000);
    expect(statement.totalAdjustmentsInPaisa).toBe(500);

    // No `from` at all: opening is 0 and EVERY line (including the D0 pair
    // and the AFTER_TO purchase, now that `to` covers it) is "in range".
    const fullHistory = await supplierStatement.getSupplierStatement(restaurantId, supplier.id, TZ, {
      to: AFTER_TO,
    });
    expect(fullHistory.openingBalanceInPaisa).toBe(0);
    expect(fullHistory.lines).toHaveLength(8);
    expect(fullHistory.closingBalanceInPaisa).toBe(9_500 + 9_999);
  });

  it("edge case: a supplier with zero activity has a zero opening and closing balance and no lines", async () => {
    const supplier = await createSupplier("TEST Quiet Supplier");
    const statement = await supplierStatement.getSupplierStatement(restaurantId, supplier.id, TZ);
    expect(statement.openingBalanceInPaisa).toBe(0);
    expect(statement.closingBalanceInPaisa).toBe(0);
    expect(statement.lines).toEqual([]);
  });

  it("recordSupplierPayment allocates a lump-sum payment across multiple outstanding purchases oldest-first (FIFO)", async () => {
    const supplier = await createSupplier("TEST FIFO Supplier");

    const oldest = await createPurchase({ supplierId: supplier.id, totalInPaisa: 1_000, isCredit: true });
    const middle = await createPurchase({ supplierId: supplier.id, totalInPaisa: 2_000, isCredit: true });
    const newest = await createPurchase({ supplierId: supplier.id, totalInPaisa: 5_000, isCredit: true });

    const result = await db.transaction((tx) =>
      ledger.recordSupplierPayment(tx, {
        restaurantId,
        supplierId: supplier.id,
        amountInPaisa: 4_000, // fully pays oldest + middle, 1,000 toward newest
        timezone: TZ,
        recordedByUserId: ownerId,
      }),
    );
    expect(result.appliedInPaisa).toBe(4_000);
    expect(result.settlements).toHaveLength(3);

    const [oldestRow] = await db
      .select()
      .from(schema.ledgerEntries)
      .where(eq(schema.ledgerEntries.id, oldest.ledgerEntry.id));
    const [middleRow] = await db
      .select()
      .from(schema.ledgerEntries)
      .where(eq(schema.ledgerEntries.id, middle.ledgerEntry.id));
    const [newestRow] = await db
      .select()
      .from(schema.ledgerEntries)
      .where(eq(schema.ledgerEntries.id, newest.ledgerEntry.id));
    expect(oldestRow.dueStatus).toBe("settled");
    expect(middleRow.dueStatus).toBe("settled");
    expect(newestRow.dueStatus).toBe("outstanding");
    expect(newestRow.settledAmountInPaisa).toBe(1_000);

    const report = await supplierDues.getSupplierDueReport(restaurantId, TZ, { supplierId: supplier.id });
    expect(report.totalDueInPaisa).toBe(4_000); // 8,000 total - 4,000 applied

    const statement = await supplierStatement.getSupplierStatement(restaurantId, supplier.id, TZ);
    expect(statement.closingBalanceInPaisa).toBe(report.totalDueInPaisa);
  });

  it("recordSupplierPayment rejects overpayment upfront, touching nothing", async () => {
    const supplier = await createSupplier("TEST Overpay Supplier");
    await createPurchase({ supplierId: supplier.id, totalInPaisa: 1_000, isCredit: true });

    await expect(
      db.transaction((tx) =>
        ledger.recordSupplierPayment(tx, {
          restaurantId,
          supplierId: supplier.id,
          amountInPaisa: 5_000,
          timezone: TZ,
          recordedByUserId: ownerId,
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });

    const report = await supplierDues.getSupplierDueReport(restaurantId, TZ, { supplierId: supplier.id });
    expect(report.totalDueInPaisa).toBe(1_000); // untouched
  });

  it("recordSupplierPayment rejects when the supplier has no outstanding balance at all", async () => {
    const supplier = await createSupplier("TEST Clean Slate Supplier");
    await expect(
      db.transaction((tx) =>
        ledger.recordSupplierPayment(tx, {
          restaurantId,
          supplierId: supplier.id,
          amountInPaisa: 1_000,
          timezone: TZ,
          recordedByUserId: ownerId,
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("recordSupplierAdjustment: debit increases the balance owed, credit decreases it", async () => {
    const supplier = await createSupplier("TEST Adjustment Sign Supplier");
    await createPurchase({ supplierId: supplier.id, totalInPaisa: 5_000, isCredit: true });

    await db.transaction((tx) =>
      ledger.recordSupplierAdjustment(tx, {
        restaurantId,
        supplierId: supplier.id,
        direction: "debit",
        amountInPaisa: 700,
        description: "TEST late fee",
        timezone: TZ,
        recordedByUserId: ownerId,
      }),
    );
    let statement = await supplierStatement.getSupplierStatement(restaurantId, supplier.id, TZ);
    expect(statement.closingBalanceInPaisa).toBe(5_700);

    await db.transaction((tx) =>
      ledger.recordSupplierAdjustment(tx, {
        restaurantId,
        supplierId: supplier.id,
        direction: "credit",
        amountInPaisa: 1_200,
        description: "TEST return credit",
        timezone: TZ,
        recordedByUserId: ownerId,
      }),
    );
    statement = await supplierStatement.getSupplierStatement(restaurantId, supplier.id, TZ);
    expect(statement.closingBalanceInPaisa).toBe(5_700 - 1_200);
  });

  it("wrong-restaurant isolation: a supplier belonging to another restaurant can never be statemented, paid, or adjusted", async () => {
    await expect(
      supplierStatement.getSupplierStatement(restaurantId, otherSupplierId, TZ),
    ).rejects.toMatchObject({ status: 404 });

    await expect(
      db.transaction((tx) =>
        ledger.recordSupplierPayment(tx, {
          restaurantId,
          supplierId: otherSupplierId,
          amountInPaisa: 1_000,
          timezone: TZ,
          recordedByUserId: ownerId,
        }),
      ),
      // recordSupplierPayment has no supplier-ownership check of its own —
      // it simply finds no ledger_entries rows scoped to BOTH restaurantId
      // AND otherSupplierId (the cross-tenant supplier's entries are
      // scoped to otherRestaurantId), so it rejects the same way as "no
      // outstanding balance."
    ).rejects.toMatchObject({ status: 400 });

    // Confirms the above didn't leak: the other restaurant's own view of
    // that supplier is completely untouched.
    const otherReport = await supplierDues.getSupplierDueReport(otherRestaurantId, TZ, {
      supplierId: otherSupplierId,
    });
    expect(otherReport.totalDueInPaisa).toBe(0);
  });
});
