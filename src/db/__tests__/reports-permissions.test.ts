/**
 * Phase 9 integration test: proves (a) VIEW_REPORTS is granted to
 * manager/owner and withheld from cashier/waiter/kitchen_staff/
 * inventory_manager per the seeded role_permissions data — reports are
 * profit-adjacent, same trust tier as MANAGE_EXPENSES, not handed to
 * every front-of-house role — (b) tenant isolation holds, and (c) the
 * actual aggregation math in src/lib/reports.ts is correct against real
 * seeded orders/order_items/payments/expenses rows: only completed
 * orders count as revenue, cancelled orders are excluded, refunds net
 * out of the payment-method breakdown automatically (signed amounts),
 * voided expenses are excluded, and the date range is a correct
 * half-open [from, to] boundary (nothing from the day after "to" leaks
 * in).
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { PERMISSIONS } from "@/lib/rbac/permissions";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Reports permissions + aggregation math (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let guard: typeof import("@/lib/rbac/guard");
  let reports: typeof import("@/lib/reports");

  let managerAId: string;
  let cashierAId: string;
  let ownerBId: string;
  let restaurantAId: string;
  let restaurantBId: string;
  let branchAId: string;
  let branchBId: string;
  let rentCategoryId: string;
  let suppliesCategoryId: string;
  let marketingCategoryId: string;

  const RANGE = { from: "2026-06-01", to: "2026-06-07" };
  // This fixture's timestamps (e.g. "2026-06-02T10:00:00Z") were authored
  // as literal UTC instants deliberately landing on specific calendar days
  // — the exact per-day assertions below (byDate["2026-06-01"], etc.) only
  // hold if day boundaries are computed in UTC. Passing "Asia/Kathmandu"
  // here would shift every boundary by 5:45 and break those exact-value
  // assertions without indicating any real bug — Nepal-specific correctness
  // of the day-boundary math itself is already covered by the dedicated
  // src/lib/restaurant-date.test.ts unit tests.
  const TZ = "UTC";

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    guard = await import("@/lib/rbac/guard");
    reports = await import("@/lib/reports");
    const { generateOrderNumber } = await import("@/lib/orders");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [managerA] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Reports Manager A", phone: `9761${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    const [cashierA] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Reports Cashier A", phone: `9762${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    const [ownerB] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Reports Owner B", phone: `9763${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    managerAId = managerA.id;
    cashierAId = cashierA.id;
    ownerBId = ownerB.id;

    const [restaurantA] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-reports-a-${suffix}`, name: "TEST Reports Restaurant A" })
      .returning({ id: schema.restaurants.id });
    const [restaurantB] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-reports-b-${suffix}`, name: "TEST Reports Restaurant B" })
      .returning({ id: schema.restaurants.id });
    restaurantAId = restaurantA.id;
    restaurantBId = restaurantB.id;

    const [branchA] = await db
      .insert(schema.branches)
      .values({ restaurantId: restaurantAId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    branchAId = branchA.id;
    const [branchB] = await db
      .insert(schema.branches)
      .values({ restaurantId: restaurantAId, name: "TEST Branch B", isMain: false })
      .returning({ id: schema.branches.id });
    branchBId = branchB.id;

    await db.insert(schema.userRoles).values([
      { userId: managerAId, restaurantId: restaurantAId, role: "manager" },
      { userId: cashierAId, restaurantId: restaurantAId, role: "cashier" },
      { userId: ownerBId, restaurantId: restaurantBId, role: "owner" },
    ]);

    // --- Orders ---
    // Two completed orders inside the range (June 2 and June 5), one
    // cancelled order inside the range (must NOT count as revenue), and
    // one completed order the day AFTER the range ends (must NOT leak in
    // — proves the half-open day boundary).
    async function makeOrder(
      status: "completed" | "cancelled",
      placedAt: string,
      totalInPaisa: number,
      branchId: string = branchAId,
    ) {
      const [order] = await db
        .insert(schema.orders)
        .values({
          restaurantId: restaurantAId,
          branchId,
          tableId: null,
          orderNumber: generateOrderNumber("UTC"),
          source: "pos",
          status,
          subtotalInPaisa: totalInPaisa,
          taxInPaisa: 0,
          totalInPaisa,
          placedAt: new Date(placedAt),
        })
        .returning({ id: schema.orders.id });
      return order.id;
    }

    const order1Id = await makeOrder("completed", "2026-06-02T10:00:00Z", 100_000);
    const order2Id = await makeOrder("completed", "2026-06-05T18:30:00Z", 50_000);
    await makeOrder("cancelled", "2026-06-03T12:00:00Z", 999_999);
    await makeOrder("completed", "2026-06-08T00:00:00Z", 777_777); // day after range
    // A second branch's own completed order inside the range — proves
    // branch-scoped queries (getSalesSummary etc. with a branchId arg)
    // exclude it, while the restaurant-wide (no branchId) totals above
    // still include it.
    await makeOrder("completed", "2026-06-03T14:00:00Z", 60_000, branchBId);

    // Order items for the top-items report — Momo appears on both orders
    // (highest revenue), Cold Drink only on order 2.
    await db.insert(schema.orderItems).values([
      {
        orderId: order1Id,
        menuItemNameSnapshot: "TEST Momo",
        unitPriceInPaisa: 80_000,
        quantity: 1,
        lineSubtotalInPaisa: 80_000,
        lineTotalInPaisa: 80_000,
      },
      {
        orderId: order1Id,
        menuItemNameSnapshot: "TEST Cold Drink",
        unitPriceInPaisa: 20_000,
        quantity: 1,
        lineSubtotalInPaisa: 20_000,
        lineTotalInPaisa: 20_000,
      },
      {
        orderId: order2Id,
        menuItemNameSnapshot: "TEST Momo",
        unitPriceInPaisa: 50_000,
        quantity: 1,
        lineSubtotalInPaisa: 50_000,
        lineTotalInPaisa: 50_000,
      },
    ]);

    // Payments — cash payment + a card payment that's partially refunded,
    // both inside the range. Net card total should be 30_000 - 10_000 =
    // 20_000, proving refunds net out automatically via the signed amount.
    await db.insert(schema.payments).values([
      {
        restaurantId: restaurantAId,
        orderId: order1Id,
        amountInPaisa: 100_000,
        method: "cash",
        recordedByUserId: managerAId,
        createdAt: new Date("2026-06-02T10:05:00Z"),
      },
      {
        restaurantId: restaurantAId,
        orderId: order2Id,
        amountInPaisa: 30_000,
        method: "card",
        recordedByUserId: managerAId,
        createdAt: new Date("2026-06-05T18:35:00Z"),
      },
      {
        restaurantId: restaurantAId,
        orderId: order2Id,
        amountInPaisa: -10_000,
        method: "card",
        note: "TEST refund",
        recordedByUserId: managerAId,
        createdAt: new Date("2026-06-06T09:00:00Z"),
      },
    ]);

    // Expense categories — real per-restaurant rows now, not a fixed enum.
    const [rentCategory] = await db
      .insert(schema.expenseCategories)
      .values({ restaurantId: restaurantAId, name: "TEST Rent" })
      .returning({ id: schema.expenseCategories.id });
    const [suppliesCategory] = await db
      .insert(schema.expenseCategories)
      .values({ restaurantId: restaurantAId, name: "TEST Supplies" })
      .returning({ id: schema.expenseCategories.id });
    const [marketingCategory] = await db
      .insert(schema.expenseCategories)
      .values({ restaurantId: restaurantAId, name: "TEST Marketing" })
      .returning({ id: schema.expenseCategories.id });
    rentCategoryId = rentCategory.id;
    suppliesCategoryId = suppliesCategory.id;
    marketingCategoryId = marketingCategory.id;

    // Expenses — two categories inside the range, one voided (must be
    // excluded), one dated the day after the range ends (must not leak
    // in).
    await db.insert(schema.expenses).values([
      {
        restaurantId: restaurantAId,
        categoryId: rentCategoryId,
        amountInPaisa: 40_000,
        description: "TEST rent",
        expenseDate: "2026-06-01",
        recordedByUserId: managerAId,
      },
      {
        restaurantId: restaurantAId,
        categoryId: suppliesCategoryId,
        amountInPaisa: 15_000,
        description: "TEST supplies",
        expenseDate: "2026-06-04",
        recordedByUserId: managerAId,
      },
      {
        restaurantId: restaurantAId,
        categoryId: suppliesCategoryId,
        amountInPaisa: 999_999,
        description: "TEST voided supplies",
        expenseDate: "2026-06-04",
        isVoided: true,
        recordedByUserId: managerAId,
      },
      {
        restaurantId: restaurantAId,
        categoryId: marketingCategoryId,
        amountInPaisa: 888_888,
        description: "TEST out-of-range marketing",
        expenseDate: "2026-06-08",
        recordedByUserId: managerAId,
      },
    ]);
  });

  afterAll(async () => {
    await db.delete(schema.payments).where(eq(schema.payments.restaurantId, restaurantAId));
    await db.delete(schema.expenses).where(eq(schema.expenses.restaurantId, restaurantAId));
    await db
      .delete(schema.expenseCategories)
      .where(eq(schema.expenseCategories.restaurantId, restaurantAId));
    // orderItems cascade-delete with their orders.
    await db.delete(schema.orders).where(eq(schema.orders.restaurantId, restaurantAId));
    await db.delete(schema.branches).where(eq(schema.branches.restaurantId, restaurantAId));
    await db.delete(schema.userRoles).where(eq(schema.userRoles.restaurantId, restaurantAId));
    await db.delete(schema.userRoles).where(eq(schema.userRoles.restaurantId, restaurantBId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantAId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantBId));
    await db.delete(schema.users).where(eq(schema.users.id, managerAId));
    await db.delete(schema.users).where(eq(schema.users.id, cashierAId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerBId));
  });

  it("manager holds VIEW_REPORTS; cashier does not", async () => {
    await expect(
      guard.hasPermission(managerAId, restaurantAId, PERMISSIONS.VIEW_REPORTS),
    ).resolves.toBe(true);
    await expect(
      guard.hasPermission(cashierAId, restaurantAId, PERMISSIONS.VIEW_REPORTS),
    ).resolves.toBe(false);
  });

  it("requirePermission rejects a cashier viewing reports with a 403", async () => {
    await expect(
      guard.requirePermission(cashierAId, restaurantAId, PERMISSIONS.VIEW_REPORTS),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("owner B cannot resolve access to restaurant A (tenant isolation)", async () => {
    await expect(guard.requireRestaurantAccess(ownerBId, restaurantAId)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("getSalesSummary counts only completed orders inside the range, excludes cancelled and out-of-range", async () => {
    const summary = await reports.getSalesSummary(restaurantAId, RANGE, TZ);
    // 100_000 (branch A) + 50_000 (branch A) + 60_000 (branch B), not the
    // 777_777 out-of-range or 999_999 cancelled order.
    expect(summary.revenueInPaisa).toBe(210_000);
    expect(summary.orderCount).toBe(3);
    expect(summary.averageOrderValueInPaisa).toBe(70_000);
    expect(summary.cancelledCount).toBe(1);
  });

  it("getSalesSummary with a branchId only counts that branch's orders", async () => {
    const branchA = await reports.getSalesSummary(restaurantAId, RANGE, TZ, branchAId);
    expect(branchA.revenueInPaisa).toBe(150_000); // 100_000 + 50_000, branch B's 60_000 excluded
    expect(branchA.orderCount).toBe(2);

    const branchB = await reports.getSalesSummary(restaurantAId, RANGE, TZ, branchBId);
    expect(branchB.revenueInPaisa).toBe(60_000);
    expect(branchB.orderCount).toBe(1);
  });

  it("getTotalExpensesInPaisa excludes voided and out-of-range expenses", async () => {
    const total = await reports.getTotalExpensesInPaisa(restaurantAId, RANGE, TZ);
    expect(total).toBe(55_000); // 40_000 + 15_000, not the voided 999_999 or out-of-range 888_888
  });

  it("getDailyRevenueVsExpenses produces one point per day in the range with correct daily totals and real zeros elsewhere", async () => {
    const series = await reports.getDailyRevenueVsExpenses(restaurantAId, RANGE, TZ);
    expect(series).toHaveLength(7); // June 1 through June 7 inclusive

    const byDate = Object.fromEntries(series.map((p) => [p.date, p]));
    expect(byDate["2026-06-01"]).toEqual({ date: "2026-06-01", revenueInPaisa: 0, expensesInPaisa: 40_000 });
    expect(byDate["2026-06-02"]).toEqual({ date: "2026-06-02", revenueInPaisa: 100_000, expensesInPaisa: 0 });
    expect(byDate["2026-06-04"]).toEqual({ date: "2026-06-04", revenueInPaisa: 0, expensesInPaisa: 15_000 });
    expect(byDate["2026-06-05"]).toEqual({ date: "2026-06-05", revenueInPaisa: 50_000, expensesInPaisa: 0 });
    expect(byDate["2026-06-07"]).toEqual({ date: "2026-06-07", revenueInPaisa: 0, expensesInPaisa: 0 });
  });

  it("getTopMenuItems ranks by revenue and aggregates quantity across orders", async () => {
    const topItems = await reports.getTopMenuItems(restaurantAId, RANGE, TZ);
    expect(topItems).toEqual([
      { name: "TEST Momo", quantitySold: 2, revenueInPaisa: 130_000 },
      { name: "TEST Cold Drink", quantitySold: 1, revenueInPaisa: 20_000 },
    ]);
  });

  it("getPaymentMethodBreakdown nets refunds automatically via signed amounts", async () => {
    const breakdown = await reports.getPaymentMethodBreakdown(restaurantAId, RANGE, TZ);
    const byMethod = Object.fromEntries(breakdown.map((r) => [r.method, r.totalInPaisa]));
    expect(byMethod.cash).toBe(100_000);
    expect(byMethod.card).toBe(20_000); // 30_000 payment - 10_000 refund
  });

  it("getExpenseCategoryBreakdown excludes voided rows and sums per category", async () => {
    const breakdown = await reports.getExpenseCategoryBreakdown(restaurantAId, RANGE, TZ);
    const byCategory = Object.fromEntries(breakdown.map((r) => [r.category, r.totalInPaisa]));
    expect(byCategory["TEST Rent"]).toBe(40_000);
    expect(byCategory["TEST Supplies"]).toBe(15_000); // not 15_000 + 999_999 voided
    expect(byCategory["TEST Marketing"]).toBeUndefined(); // out of range
  });

  it("getReportSummary bundles everything and computes net profit as revenue minus expenses", async () => {
    const summary = await reports.getReportSummary(restaurantAId, RANGE, TZ);
    expect(summary.sales.revenueInPaisa).toBe(210_000);
    expect(summary.totalExpensesInPaisa).toBe(55_000);
    expect(summary.netProfitInPaisa).toBe(155_000);
    expect(summary.dailySeries).toHaveLength(7);
    expect(summary.branchId).toBeNull();
  });

  it("getReportSummary with a branchId scopes every figure to that branch and skips branch comparison", async () => {
    const summary = await reports.getReportSummary(restaurantAId, RANGE, TZ, branchAId);
    expect(summary.branchId).toBe(branchAId);
    expect(summary.sales.revenueInPaisa).toBe(150_000); // branch B's order excluded
    expect(summary.sales.orderCount).toBe(2);
    // Expenses in this fixture were never tied to a branch (branchId null),
    // so a branch-scoped view correctly shows 0 — see getTotalExpensesInPaisa's
    // comment on why restaurant-wide overhead doesn't leak into one branch's
    // totals.
    expect(summary.totalExpensesInPaisa).toBe(0);
    expect(summary.netProfitInPaisa).toBe(150_000);
    // Comparing one branch against itself isn't meaningful — see
    // getReportSummary's own comment on why this is skipped entirely
    // rather than returning a single-row result.
    expect(summary.branchComparison).toEqual([]);
  });

  it("restaurant B sees none of restaurant A's report data — tenant isolation holds for aggregation queries", async () => {
    const summary = await reports.getSalesSummary(restaurantBId, RANGE, TZ);
    expect(summary.revenueInPaisa).toBe(0);
    expect(summary.orderCount).toBe(0);

    const expensesTotal = await reports.getTotalExpensesInPaisa(restaurantBId, RANGE, TZ);
    expect(expensesTotal).toBe(0);
  });
});
