/**
 * Commercial-launch Phase A.2 regression tests for src/lib/daily-closing.ts.
 *
 * Same convention as every other DB-backed integration test in this
 * project (see cash-register.test.ts's own doc comment for the fuller
 * explanation): the routes resolve session/permissions via
 * resolveRestaurantContext()/requireBranchAccess(), which have no mocking
 * harness here, so this file exercises the actual business logic
 * (getPurchasesSummary/getCashExpensesSummary/getStockAdjustmentsSummary/
 * getRegisterSummaryForDay/closeDailyBusiness/isBusinessDateClosed)
 * directly at the DB level, plus the closed-day lock's core primitive
 * that the refunds route's gate depends on.
 *
 * Skipped (not failed) when DATABASE_URL isn't set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);
const TZ = "UTC";
const BUSINESS_DATE = "2024-02-01";
const OTHER_DATE = "2024-02-02";

describe.skipIf(!hasDb)("Daily closing (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let dailyClosing: typeof import("@/lib/daily-closing");

  let restaurantId: string;
  let branchId: string;
  let userId: string;
  let expenseCategoryId: string;
  let inventoryItemId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    dailyClosing = await import("@/lib/daily-closing");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-daily-closing-${suffix}`, name: "TEST Daily Closing Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;

    const [user] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Closer", phone: `972${suffix}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    userId = user.id;

    const [expenseCategory] = await db
      .insert(schema.expenseCategories)
      .values({ restaurantId, name: "TEST Daily Closing Supplies" })
      .returning({ id: schema.expenseCategories.id });
    expenseCategoryId = expenseCategory.id;

    const [inventoryItem] = await db
      .insert(schema.inventoryItems)
      .values({
        restaurantId,
        name: "TEST Daily Closing Flour",
        unit: "kg",
        costPerUnitInPaisa: 10_000,
      })
      .returning({ id: schema.inventoryItems.id });
    inventoryItemId = inventoryItem.id;

    // Fixture data landing on BUSINESS_DATE (2024-02-01, UTC).
    const [purchase] = await db
      .insert(schema.purchases)
      .values({
        restaurantId,
        branchId,
        totalInPaisa: 8_000,
        createdAt: new Date("2024-02-01T09:00:00Z"),
      })
      .returning({ id: schema.purchases.id });
    void purchase;

    await db.insert(schema.expenses).values({
      restaurantId,
      branchId,
      categoryId: expenseCategoryId,
      amountInPaisa: 3_000,
      description: "TEST cash expense",
      status: "paid",
      paymentMethod: "cash",
      paidAt: new Date("2024-02-01T10:00:00Z"),
    });

    // A stock adjustment (NOT wastage) — +2kg found on recount, at
    // 10_000 paisa/kg -> +20_000 paisa net value change.
    await db.insert(schema.stockMovements).values({
      restaurantId,
      branchId,
      inventoryItemId,
      type: "adjustment",
      quantityDeltaMilliunits: 2_000,
      createdAt: new Date("2024-02-01T11:00:00Z"),
    });

    // A closed register shift landing on BUSINESS_DATE.
    await db.insert(schema.registerShifts).values({
      restaurantId,
      branchId,
      registerName: "TEST Daily Closing Register",
      status: "closed",
      openedByUserId: userId,
      openedAt: new Date("2024-02-01T08:00:00Z"),
      openingCashInPaisa: 5_000,
      closedByUserId: userId,
      closedAt: new Date("2024-02-01T20:00:00Z"),
      actualCashInPaisa: 12_000,
      expectedCashInPaisa: 12_500,
      varianceInPaisa: -500,
    });
  });

  afterAll(async () => {
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  it("getPurchasesSummary sums purchases landing on the business date, scoped to the branch", async () => {
    const summary = await dailyClosing.getPurchasesSummary(restaurantId, BUSINESS_DATE, TZ, branchId);
    expect(summary.totalInPaisa).toBe(8_000);
    expect(summary.purchaseCount).toBe(1);

    const otherDay = await dailyClosing.getPurchasesSummary(restaurantId, OTHER_DATE, TZ, branchId);
    expect(otherDay.totalInPaisa).toBe(0);
  });

  it("getCashExpensesSummary sums only cash, paid, non-voided expenses on the business date", async () => {
    const summary = await dailyClosing.getCashExpensesSummary(restaurantId, BUSINESS_DATE, TZ, branchId);
    expect(summary.totalInPaisa).toBe(3_000);
  });

  it("getStockAdjustmentsSummary reports net value change for type='adjustment' movements only", async () => {
    const summary = await dailyClosing.getStockAdjustmentsSummary(restaurantId, BUSINESS_DATE, TZ, branchId);
    expect(summary.netValueChangeInPaisa).toBe(20_000);
    expect(summary.movementCount).toBe(1);
  });

  it("getRegisterSummaryForDay aggregates shifts closed on the business date, and reports null when none closed", async () => {
    const withShift = await dailyClosing.getRegisterSummaryForDay(restaurantId, BUSINESS_DATE, TZ, branchId);
    expect(withShift.shiftsClosedCount).toBe(1);
    expect(withShift.openingCashInPaisa).toBe(5_000);
    expect(withShift.expectedCashInPaisa).toBe(12_500);
    expect(withShift.actualCashInPaisa).toBe(12_000);
    expect(withShift.varianceInPaisa).toBe(-500);

    const withoutShift = await dailyClosing.getRegisterSummaryForDay(restaurantId, OTHER_DATE, TZ, branchId);
    expect(withoutShift.shiftsClosedCount).toBe(0);
    expect(withoutShift.varianceInPaisa).toBeNull();
  });

  it("getDailyClosingPreview assembles every section without throwing, and is a live preview (isBusinessDateClosed is false before closing)", async () => {
    expect(await dailyClosing.isBusinessDateClosed(restaurantId, branchId, BUSINESS_DATE)).toBe(false);

    const preview = await dailyClosing.getDailyClosingPreview(restaurantId, branchId, BUSINESS_DATE, TZ);
    expect(preview.expenses.cashExpensesInPaisa).toBe(3_000);
    expect(preview.expenses.purchasesInPaisa).toBe(8_000);
    expect(preview.inventory.stockAdjustmentNetValueChangeInPaisa).toBe(20_000);
    expect(preview.register.shiftsClosedCount).toBe(1);
    expect(preview.register.varianceInPaisa).toBe(-500);
    // grossSalesInPaisa reconstruction: net + discount + refund, all zero
    // here since this fixture has no orders, so it should just be 0, not NaN/throw.
    expect(preview.sales.grossSalesInPaisa).toBe(0);
  });

  it("closeDailyBusiness freezes a snapshot, is idempotent-safe (rejects a duplicate close), and the frozen snapshot doesn't drift when later data changes", async () => {
    const closed = await db.transaction((tx) =>
      dailyClosing.closeDailyBusiness(tx, {
        restaurantId,
        branchId,
        businessDate: BUSINESS_DATE,
        timezone: TZ,
        closedByUserId: userId,
        notes: "TEST close",
      }),
    );
    expect(closed.cashVarianceInPaisa).toBe(-500);
    expect(closed.notes).toBe("TEST close");

    expect(await dailyClosing.isBusinessDateClosed(restaurantId, branchId, BUSINESS_DATE)).toBe(true);

    // Duplicate close attempt -> rejected (unique index).
    await expect(
      db.transaction((tx) =>
        dailyClosing.closeDailyBusiness(tx, {
          restaurantId,
          branchId,
          businessDate: BUSINESS_DATE,
          timezone: TZ,
          closedByUserId: userId,
        }),
      ),
    ).rejects.toBeInstanceOf(dailyClosing.DailyClosingError);

    // A LATE expense lands on the same (already-closed) business date.
    await db.insert(schema.expenses).values({
      restaurantId,
      branchId,
      categoryId: expenseCategoryId,
      amountInPaisa: 999_00,
      description: "TEST late cash expense after close",
      status: "paid",
      paymentMethod: "cash",
      paidAt: new Date("2024-02-01T23:00:00Z"),
    });

    // The frozen row is untouched — closeDailyBusiness never re-runs.
    const [frozen] = await db
      .select()
      .from(schema.dailyCloses)
      .where(eq(schema.dailyCloses.id, closed.id));
    const snapshot = frozen.snapshotJson as { expenses: { cashExpensesInPaisa: number } };
    expect(snapshot.expenses.cashExpensesInPaisa).toBe(3_000);

    // A live preview computed AFTER the late expense DOES pick it up —
    // proving the discrepancy is real (the late data exists) and that
    // only the frozen snapshot, not the underlying data, is locked.
    const previewAfterLateExpense = await dailyClosing.getDailyClosingPreview(
      restaurantId,
      branchId,
      BUSINESS_DATE,
      TZ,
    );
    expect(previewAfterLateExpense.expenses.cashExpensesInPaisa).toBe(3_000 + 999_00);
  });

  it("isBusinessDateClosed is branch-scoped — closing one branch's day doesn't lock a different branch's same day", async () => {
    const [otherBranch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "TEST Other Branch", isMain: false })
      .returning({ id: schema.branches.id });

    // BUSINESS_DATE was already closed for `branchId` in the previous test.
    expect(await dailyClosing.isBusinessDateClosed(restaurantId, branchId, BUSINESS_DATE)).toBe(true);
    expect(await dailyClosing.isBusinessDateClosed(restaurantId, otherBranch.id, BUSINESS_DATE)).toBe(false);
  });
});
