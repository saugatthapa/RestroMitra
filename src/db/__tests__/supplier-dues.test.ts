/**
 * Commercial-launch Phase A.3 regression tests for src/lib/supplier-dues.ts
 * (getSupplierDueReport / voidPurchase) plus the recordPurchaseLedgerEntry
 * markAsDue extension (src/lib/ledger.ts) both routes delegate to.
 *
 * Same convention as every other DB-backed integration test in this
 * project (see cash-register.test.ts's own doc comment for the fuller
 * explanation): the routes resolve session/permissions via
 * resolveRestaurantContext()/requireBranchAccess(), which have no mocking
 * harness here — RBAC/tenant/branch scoping for THOSE primitives is
 * already covered by rbac/guard's own tests, so this file exercises the
 * actual business logic directly: due-report bucketing/filtering,
 * settlement-reuse interaction, void success/rejection paths (including
 * concurrency), and tenant isolation of the report query itself.
 *
 * Fixture dates are fixed, safely-PAST calendar dates (2024-xx-xx) with
 * every manual assertion using the SAME reference date the code itself
 * derives "today" from (restaurantDate(timezone) at call time) — see this
 * file's own use of a fixed `TODAY`/`YESTERDAY`/etc. computed once, not a
 * hardcoded string, so the overdue/due-today/due-this-week bucketing is
 * always correct relative to whatever day the test actually runs on
 * (avoiding the Oct-2026-vs-real-clock mistake documented in
 * cash-register.test.ts's history).
 *
 * Skipped (not failed) when DATABASE_URL isn't set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { recordStockMovement } from "@/lib/inventory";

const hasDb = Boolean(process.env.DATABASE_URL);
const TZ = "UTC";

function isoDaysFromNow(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

describe.skipIf(!hasDb)("Supplier dues (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let ledger: typeof import("@/lib/ledger");
  let supplierDues: typeof import("@/lib/supplier-dues");

  let restaurantId: string;
  let otherRestaurantId: string;
  let branchId: string;
  let branchBId: string;
  let userId: string;
  let supplierAId: string;
  let supplierBId: string;
  let inventoryItemId: string;

  const TODAY = isoDaysFromNow(0);
  const YESTERDAY = isoDaysFromNow(-1);
  const IN_3_DAYS = isoDaysFromNow(3);
  const IN_30_DAYS = isoDaysFromNow(30);

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    ledger = await import("@/lib/ledger");
    supplierDues = await import("@/lib/supplier-dues");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-supplier-dues-${suffix}`, name: "TEST Supplier Dues Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [otherRestaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-supplier-dues-other-${suffix}`, name: "TEST Other Restaurant" })
      .returning({ id: schema.restaurants.id });
    otherRestaurantId = otherRestaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;

    const [branchB] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Branch B", isMain: false })
      .returning({ id: schema.branches.id });
    branchBId = branchB.id;

    const [user] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Supplier Dues User", phone: `973${suffix}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    userId = user.id;

    const [supplierA] = await db
      .insert(schema.suppliers)
      .values({ restaurantId, name: "TEST Supplier A" })
      .returning({ id: schema.suppliers.id });
    supplierAId = supplierA.id;

    const [supplierB] = await db
      .insert(schema.suppliers)
      .values({ restaurantId, name: "TEST Supplier B" })
      .returning({ id: schema.suppliers.id });
    supplierBId = supplierB.id;

    const [inventoryItem] = await db
      .insert(schema.inventoryItems)
      .values({ restaurantId, name: "TEST Rice", unit: "kg", costPerUnitInPaisa: 0, currentStockMilliunits: 0 })
      .returning({ id: schema.inventoryItems.id });
    inventoryItemId = inventoryItem.id;
  });

  afterAll(async () => {
    // Both purchase_items.inventoryItemId and branch_inventory_levels.branchId
    // are deliberately ON DELETE RESTRICT (see their own schema comments) —
    // delete purchases first (cascades purchase_items), then the inventory
    // item (cascades its branch-level rows), clearing the way for the
    // restaurant delete's cascade to reach everything else cleanly.
    await db.delete(schema.purchases).where(eq(schema.purchases.restaurantId, restaurantId));
    await db.delete(schema.inventoryItems).where(eq(schema.inventoryItems.restaurantId, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, otherRestaurantId));
  });

  /** Mirrors what the purchases POST route does, minus HTTP/session plumbing. */
  async function createCreditPurchase(opts: {
    supplierId: string;
    branchId: string;
    totalInPaisa: number;
    dueDate: string | null;
    quantityMilliunits?: number;
  }) {
    return db.transaction(async (tx) => {
      const [purchase] = await tx
        .insert(schema.purchases)
        .values({
          restaurantId,
          branchId: opts.branchId,
          supplierId: opts.supplierId,
          totalInPaisa: opts.totalInPaisa,
          isCredit: true,
          dueDate: opts.dueDate,
          recordedByUserId: userId,
        })
        .returning();

      const quantityMilliunits = opts.quantityMilliunits ?? 1_000;
      await tx.insert(schema.purchaseItems).values({
        purchaseId: purchase.id,
        inventoryItemId,
        quantityMilliunits,
        unitCostInPaisa: opts.totalInPaisa,
        lineTotalInPaisa: opts.totalInPaisa,
      });
      await recordStockMovement(tx, {
        restaurantId,
        branchId: opts.branchId,
        inventoryItemId,
        type: "purchase",
        quantityDeltaMilliunits: quantityMilliunits,
        referenceType: "purchase",
        referenceId: purchase.id,
        recordedByUserId: userId,
      });

      const ledgerEntry = await ledger.recordPurchaseLedgerEntry(tx, {
        restaurantId,
        purchaseId: purchase.id,
        totalInPaisa: opts.totalInPaisa,
        supplierName: null,
        invoiceNumber: null,
        timezone: TZ,
        markAsDue: true,
        recordedByUserId: userId,
      });

      return { purchase, ledgerEntry: ledgerEntry! };
    });
  }

  it("getSupplierDueReport buckets outstanding purchases by overdue/due-today/due-this-week and rolls up per supplier", async () => {
    const overdue = await createCreditPurchase({
      supplierId: supplierAId,
      branchId,
      totalInPaisa: 10_000,
      dueDate: YESTERDAY,
    });
    const dueToday = await createCreditPurchase({
      supplierId: supplierAId,
      branchId,
      totalInPaisa: 5_000,
      dueDate: TODAY,
    });
    const dueThisWeek = await createCreditPurchase({
      supplierId: supplierBId,
      branchId,
      totalInPaisa: 7_000,
      dueDate: IN_3_DAYS,
    });
    const notDueSoon = await createCreditPurchase({
      supplierId: supplierBId,
      branchId,
      totalInPaisa: 20_000,
      dueDate: IN_30_DAYS,
    });
    void notDueSoon;

    const report = await supplierDues.getSupplierDueReport(restaurantId, TZ);

    expect(report.totalDueInPaisa).toBe(10_000 + 5_000 + 7_000 + 20_000);
    expect(report.overdueInPaisa).toBe(10_000);
    expect(report.dueTodayInPaisa).toBe(5_000);
    expect(report.dueThisWeekInPaisa).toBe(7_000);

    const supplierARow = report.supplierWise.find((s) => s.supplierId === supplierAId)!;
    expect(supplierARow.outstandingInPaisa).toBe(15_000);
    expect(supplierARow.overdueInPaisa).toBe(10_000);
    expect(supplierARow.purchaseCount).toBe(2);

    const overdueOnly = await supplierDues.getSupplierDueReport(restaurantId, TZ, { status: "overdue" });
    expect(overdueOnly.rows.map((r) => r.purchaseId)).toEqual([overdue.purchase.id]);
    // Bucket totals stay full-set even when `rows` is narrowed by status.
    expect(overdueOnly.totalDueInPaisa).toBe(report.totalDueInPaisa);

    const dueTodayOnly = await supplierDues.getSupplierDueReport(restaurantId, TZ, { status: "due_today" });
    expect(dueTodayOnly.rows.map((r) => r.purchaseId)).toEqual([dueToday.purchase.id]);

    const supplierBOnly = await supplierDues.getSupplierDueReport(restaurantId, TZ, { supplierId: supplierBId });
    expect(supplierBOnly.rows.map((r) => r.purchaseId).sort()).toEqual(
      [dueThisWeek.purchase.id, notDueSoon.purchase.id].sort(),
    );
  });

  it("branch filter scopes the report, and a purchase on another branch is excluded", async () => {
    const branchBPurchase = await createCreditPurchase({
      supplierId: supplierAId,
      branchId: branchBId,
      totalInPaisa: 12_345,
      dueDate: TODAY,
    });

    const branchBReport = await supplierDues.getSupplierDueReport(restaurantId, TZ, { branchId: branchBId });
    expect(branchBReport.rows.map((r) => r.purchaseId)).toEqual([branchBPurchase.purchase.id]);

    const branchAReport = await supplierDues.getSupplierDueReport(restaurantId, TZ, { branchId });
    expect(branchAReport.rows.some((r) => r.purchaseId === branchBPurchase.purchase.id)).toBe(false);
  });

  it("wrong-restaurant isolation: a purchase belonging to another restaurant never appears in this restaurant's report", async () => {
    const [otherBranch] = await db
      .insert(schema.branches)
      .values({ restaurantId: otherRestaurantId, name: "Other Main", isMain: true })
      .returning({ id: schema.branches.id });
    const [otherSupplier] = await db
      .insert(schema.suppliers)
      .values({ restaurantId: otherRestaurantId, name: "TEST Other Supplier" })
      .returning({ id: schema.suppliers.id });
    const [otherPurchase] = await db
      .insert(schema.purchases)
      .values({
        restaurantId: otherRestaurantId,
        branchId: otherBranch.id,
        supplierId: otherSupplier.id,
        totalInPaisa: 99_999,
        isCredit: true,
        dueDate: TODAY,
      })
      .returning();
    await db.transaction((tx) =>
      ledger.recordPurchaseLedgerEntry(tx, {
        restaurantId: otherRestaurantId,
        purchaseId: otherPurchase.id,
        totalInPaisa: 99_999,
        timezone: TZ,
        markAsDue: true,
      }),
    );

    const thisReport = await supplierDues.getSupplierDueReport(restaurantId, TZ);
    expect(thisReport.rows.some((r) => r.purchaseId === otherPurchase.id)).toBe(false);

    const otherReport = await supplierDues.getSupplierDueReport(otherRestaurantId, TZ);
    expect(otherReport.rows.map((r) => r.purchaseId)).toEqual([otherPurchase.id]);
  });

  it("settling a due via settleLedgerDue (the reused generic endpoint) reduces the outstanding amount and, once fully paid, drops it from the report", async () => {
    const p = await createCreditPurchase({
      supplierId: supplierAId,
      branchId,
      totalInPaisa: 8_000,
      dueDate: TODAY,
    });

    await db.transaction((tx) =>
      ledger.settleLedgerDue(tx, {
        restaurantId,
        entryId: p.ledgerEntry.id,
        amountInPaisa: 3_000,
        timezone: TZ,
        recordedByUserId: userId,
      }),
    );

    const partial = await supplierDues.getSupplierDueReport(restaurantId, TZ);
    const partialRow = partial.rows.find((r) => r.purchaseId === p.purchase.id)!;
    expect(partialRow.outstandingInPaisa).toBe(5_000);
    expect(partialRow.settledAmountInPaisa).toBe(3_000);

    await db.transaction((tx) =>
      ledger.settleLedgerDue(tx, {
        restaurantId,
        entryId: p.ledgerEntry.id,
        amountInPaisa: 5_000,
        timezone: TZ,
        recordedByUserId: userId,
      }),
    );

    const full = await supplierDues.getSupplierDueReport(restaurantId, TZ);
    expect(full.rows.some((r) => r.purchaseId === p.purchase.id)).toBe(false);
  });

  it("voidPurchase happy path: reverses the stock quantity, voids the linked ledger due, and marks the purchase voided", async () => {
    const [before] = await db
      .select({ stock: schema.inventoryItems.currentStockMilliunits })
      .from(schema.inventoryItems)
      .where(eq(schema.inventoryItems.id, inventoryItemId));

    const p = await createCreditPurchase({
      supplierId: supplierAId,
      branchId,
      totalInPaisa: 4_000,
      dueDate: TODAY,
      quantityMilliunits: 2_000,
    });

    const [afterPurchase] = await db
      .select({ stock: schema.inventoryItems.currentStockMilliunits })
      .from(schema.inventoryItems)
      .where(eq(schema.inventoryItems.id, inventoryItemId));
    expect(afterPurchase.stock).toBe(before.stock + 2_000);

    const result = await db.transaction((tx) =>
      supplierDues.voidPurchase(tx, {
        restaurantId,
        purchaseId: p.purchase.id,
        voidedByUserId: userId,
        reason: "TEST duplicate entry",
        timezone: TZ,
      }),
    );
    expect(result.purchase.isVoided).toBe(true);
    expect(result.purchase.voidedByUserId).toBe(userId);
    expect(result.reversedLineItemCount).toBe(1);

    const [afterVoid] = await db
      .select({ stock: schema.inventoryItems.currentStockMilliunits })
      .from(schema.inventoryItems)
      .where(eq(schema.inventoryItems.id, inventoryItemId));
    expect(afterVoid.stock).toBe(before.stock);

    const [ledgerRow] = await db
      .select()
      .from(schema.ledgerEntries)
      .where(eq(schema.ledgerEntries.id, p.ledgerEntry.id));
    expect(ledgerRow.isVoided).toBe(true);

    const reportAfterVoid = await supplierDues.getSupplierDueReport(restaurantId, TZ);
    expect(reportAfterVoid.rows.some((r) => r.purchaseId === p.purchase.id)).toBe(false);
  });

  it("voidPurchase rejects a purchase that has already been voided (duplicate void request)", async () => {
    const p = await createCreditPurchase({
      supplierId: supplierAId,
      branchId,
      totalInPaisa: 1_000,
      dueDate: TODAY,
    });
    await db.transaction((tx) =>
      supplierDues.voidPurchase(tx, {
        restaurantId,
        purchaseId: p.purchase.id,
        voidedByUserId: userId,
        reason: "TEST first void",
        timezone: TZ,
      }),
    );

    await expect(
      db.transaction((tx) =>
        supplierDues.voidPurchase(tx, {
          restaurantId,
          purchaseId: p.purchase.id,
          voidedByUserId: userId,
          reason: "TEST second void",
          timezone: TZ,
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("voidPurchase rejects (rolls back) once any payment has been recorded against the purchase — the stock quantity stays reversed-nothing / unchanged", async () => {
    const p = await createCreditPurchase({
      supplierId: supplierAId,
      branchId,
      totalInPaisa: 6_000,
      dueDate: TODAY,
      quantityMilliunits: 3_000,
    });
    await db.transaction((tx) =>
      ledger.settleLedgerDue(tx, {
        restaurantId,
        entryId: p.ledgerEntry.id,
        amountInPaisa: 1_000,
        timezone: TZ,
        recordedByUserId: userId,
      }),
    );

    const [beforeVoidAttempt] = await db
      .select({ stock: schema.inventoryItems.currentStockMilliunits })
      .from(schema.inventoryItems)
      .where(eq(schema.inventoryItems.id, inventoryItemId));

    await expect(
      db.transaction((tx) =>
        supplierDues.voidPurchase(tx, {
          restaurantId,
          purchaseId: p.purchase.id,
          voidedByUserId: userId,
          reason: "TEST should be rejected",
          timezone: TZ,
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });

    // The whole transaction rolled back — no partial stock reversal leaked
    // through despite the rejection happening after the settle check.
    const [afterVoidAttempt] = await db
      .select({ stock: schema.inventoryItems.currentStockMilliunits })
      .from(schema.inventoryItems)
      .where(eq(schema.inventoryItems.id, inventoryItemId));
    expect(afterVoidAttempt.stock).toBe(beforeVoidAttempt.stock);

    const [purchaseRow] = await db.select().from(schema.purchases).where(eq(schema.purchases.id, p.purchase.id));
    expect(purchaseRow.isVoided).toBe(false);
  });

  it("voidPurchase on a nonexistent purchase throws 404 (validation failure)", async () => {
    await expect(
      db.transaction((tx) =>
        supplierDues.voidPurchase(tx, {
          restaurantId,
          purchaseId: "00000000-0000-0000-0000-000000000000",
          voidedByUserId: userId,
          reason: "TEST not found",
          timezone: TZ,
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("two concurrent voidPurchase calls on the same purchase: exactly one succeeds, the other gets a clean conflict", async () => {
    const p = await createCreditPurchase({
      supplierId: supplierAId,
      branchId,
      totalInPaisa: 2_500,
      dueDate: TODAY,
      quantityMilliunits: 1_000,
    });

    const attempt = () =>
      db
        .transaction((tx) =>
          supplierDues.voidPurchase(tx, {
            restaurantId,
            purchaseId: p.purchase.id,
            voidedByUserId: userId,
            reason: "TEST concurrent void",
            timezone: TZ,
          }),
        )
        .then((r) => ({ ok: true as const, r }))
        .catch((err) => ({ ok: false as const, err }));

    const [a, b] = await Promise.all([attempt(), attempt()]);
    const outcomes = [a, b];
    const succeeded = outcomes.filter((o) => o.ok);
    const failed = outcomes.filter((o) => !o.ok);

    // Postgres row-locking (SELECT ... FOR UPDATE inside voidPurchase)
    // fully serializes these two attempts, so exactly one must succeed —
    // never both (double-reversing the same stock quantity) and never
    // neither.
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as { ok: false; err: unknown }).err).toMatchObject({ status: 409 });

    const [purchaseRow] = await db.select().from(schema.purchases).where(eq(schema.purchases.id, p.purchase.id));
    expect(purchaseRow.isVoided).toBe(true);
  });

  it("voidPurchase also works for a non-credit (immediately-paid) purchase, edge case: dueStatus 'none' still voids cleanly", async () => {
    const [purchase] = await db
      .insert(schema.purchases)
      .values({
        restaurantId,
        branchId,
        supplierId: supplierAId,
        totalInPaisa: 1_500,
        isCredit: false,
      })
      .returning();
    await db.insert(schema.purchaseItems).values({
      purchaseId: purchase.id,
      inventoryItemId,
      quantityMilliunits: 500,
      unitCostInPaisa: 1_500,
      lineTotalInPaisa: 1_500,
    });
    await db.transaction((tx) =>
      recordStockMovement(tx, {
        restaurantId,
        branchId,
        inventoryItemId,
        type: "purchase",
        quantityDeltaMilliunits: 500,
        referenceType: "purchase",
        referenceId: purchase.id,
        recordedByUserId: userId,
      }),
    );
    const ledgerEntry = await db.transaction((tx) =>
      ledger.recordPurchaseLedgerEntry(tx, {
        restaurantId,
        purchaseId: purchase.id,
        totalInPaisa: 1_500,
        timezone: TZ,
        markAsDue: false,
        recordedByUserId: userId,
      }),
    );
    expect(ledgerEntry!.dueStatus).toBe("none");

    const result = await db.transaction((tx) =>
      supplierDues.voidPurchase(tx, {
        restaurantId,
        purchaseId: purchase.id,
        voidedByUserId: userId,
        reason: "TEST void a cash purchase",
        timezone: TZ,
      }),
    );
    expect(result.purchase.isVoided).toBe(true);

    const [ledgerRow] = await db.select().from(schema.ledgerEntries).where(eq(schema.ledgerEntries.id, ledgerEntry!.id));
    expect(ledgerRow.isVoided).toBe(true);
  });
});
