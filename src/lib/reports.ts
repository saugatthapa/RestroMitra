import "server-only";
import { and, asc, desc, eq, gte, lt, lte, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { orders, orderItems, payments, expenses, branches } from "@/db/schema";
import {
  generateDateRange,
  mergeDailySeries,
  computeNetProfitInPaisa,
  computeAverageOrderValueInPaisa,
  previousPeriodRange,
  percentChange,
  type DailySeriesPoint,
} from "@/lib/reports-helpers";
import type { PaymentMethod } from "@/lib/payments";
import type { ExpenseCategory } from "@/lib/expense-categories";

export type ReportDateRange = {
  /** YYYY-MM-DD, inclusive. */
  from: string;
  /** YYYY-MM-DD, inclusive. */
  to: string;
};

/**
 * "Revenue" throughout this module means completed orders' totalInPaisa —
 * the same definition the live dashboard's "today's sales" tile already
 * uses (src/app/dashboard/page.tsx). A served-but-not-yet-completed order
 * isn't counted, same as an order still mid-payment isn't "sales" yet.
 *
 * Every query here is scoped by orders.placedAt using a half-open
 * [dayStart, dayAfterEnd) range rather than a literal `<=` boundary on the
 * "to" day, so a timestamp exactly at midnight on the boundary day is
 * never ambiguously included/excluded. Dates are UTC calendar days, same
 * simplification flagged in the live dashboard's own comment — restaurants
 * table has a timezone column that isn't threaded through yet.
 */
function dayBounds(range: ReportDateRange) {
  const dayStart = new Date(`${range.from}T00:00:00.000Z`);
  const dayAfterEnd = new Date(`${range.to}T00:00:00.000Z`);
  dayAfterEnd.setUTCDate(dayAfterEnd.getUTCDate() + 1);
  return { dayStart, dayAfterEnd };
}

export async function getSalesSummary(restaurantId: string, range: ReportDateRange) {
  const { dayStart, dayAfterEnd } = dayBounds(range);

  const [completedRow] = await db
    .select({
      revenueInPaisa: sql<string>`coalesce(sum(${orders.totalInPaisa}), 0)`,
      orderCount: sql<string>`count(*)`,
      // Phase 13 — informational only: revenueInPaisa above is already
      // net of discount and inclusive of service charge (that's what
      // totalInPaisa means now, see order-adjustments.ts), so these are
      // surfaced separately for "how much did we give away in discounts /
      // collect in service charge" reporting, not added/subtracted again.
      discountInPaisa: sql<string>`coalesce(sum(${orders.discountInPaisa}), 0)`,
      serviceChargeInPaisa: sql<string>`coalesce(sum(${orders.serviceChargeInPaisa}), 0)`,
    })
    .from(orders)
    .where(
      and(
        eq(orders.restaurantId, restaurantId),
        eq(orders.status, "completed"),
        gte(orders.placedAt, dayStart),
        lt(orders.placedAt, dayAfterEnd),
      ),
    );

  const [cancelledRow] = await db
    .select({ count: sql<string>`count(*)` })
    .from(orders)
    .where(
      and(
        eq(orders.restaurantId, restaurantId),
        eq(orders.status, "cancelled"),
        gte(orders.placedAt, dayStart),
        lt(orders.placedAt, dayAfterEnd),
      ),
    );

  const revenueInPaisa = Number(completedRow?.revenueInPaisa ?? 0);
  const orderCount = Number(completedRow?.orderCount ?? 0);

  return {
    revenueInPaisa,
    orderCount,
    averageOrderValueInPaisa: computeAverageOrderValueInPaisa(revenueInPaisa, orderCount),
    cancelledCount: Number(cancelledRow?.count ?? 0),
    discountInPaisa: Number(completedRow?.discountInPaisa ?? 0),
    serviceChargeInPaisa: Number(completedRow?.serviceChargeInPaisa ?? 0),
  };
}

/**
 * Phase 13 — total gratuity collected in the range, scoped by
 * payments.createdAt (when the tip was actually recorded), same convention
 * as getPaymentMethodBreakdown. Deliberately NOT part of revenueInPaisa —
 * a tip is money for staff, not restaurant sales.
 */
export async function getTipsSummary(
  restaurantId: string,
  range: ReportDateRange,
): Promise<{ totalTipsInPaisa: number }> {
  const { dayStart, dayAfterEnd } = dayBounds(range);

  const [row] = await db
    .select({ totalTipsInPaisa: sql<string>`coalesce(sum(${payments.tipInPaisa}), 0)` })
    .from(payments)
    .where(
      and(
        eq(payments.restaurantId, restaurantId),
        gte(payments.createdAt, dayStart),
        lt(payments.createdAt, dayAfterEnd),
      ),
    );

  return { totalTipsInPaisa: Number(row?.totalTipsInPaisa ?? 0) };
}

export type PeakHourStats = {
  /** 0–23, UTC hour-of-day (same simplification as dayBounds — see its
   *  comment; restaurants.timezone isn't threaded through yet). Null when
   *  there are no completed orders in range at all. */
  peakOrdersHour: number | null;
  peakOrdersCount: number;
  peakSalesHour: number | null;
  peakSalesInPaisa: number;
};

/**
 * Phase 16 — which hour of the day does this restaurant get busiest, by
 * order count and separately by revenue (the two don't have to agree — a
 * lunch rush might win on order count while a big evening party wins on
 * revenue). Scoped to completed orders only, same as getSalesSummary,
 * bucketed by orders.placedAt's UTC hour-of-day, summed across every day in
 * the range (i.e. "which hour tends to be busiest," not a single day's
 * hour-by-hour breakdown).
 */
export async function getPeakHourStats(
  restaurantId: string,
  range: ReportDateRange,
): Promise<PeakHourStats> {
  const { dayStart, dayAfterEnd } = dayBounds(range);

  const rows = await db
    .select({
      hour: sql<string>`extract(hour from ${orders.placedAt} at time zone 'UTC')`,
      orderCount: sql<string>`count(*)`,
      revenueInPaisa: sql<string>`coalesce(sum(${orders.totalInPaisa}), 0)`,
    })
    .from(orders)
    .where(
      and(
        eq(orders.restaurantId, restaurantId),
        eq(orders.status, "completed"),
        gte(orders.placedAt, dayStart),
        lt(orders.placedAt, dayAfterEnd),
      ),
    )
    .groupBy(sql`1`);

  if (rows.length === 0) {
    return { peakOrdersHour: null, peakOrdersCount: 0, peakSalesHour: null, peakSalesInPaisa: 0 };
  }

  let peakOrders = rows[0];
  let peakSales = rows[0];
  for (const row of rows) {
    if (Number(row.orderCount) > Number(peakOrders.orderCount)) peakOrders = row;
    if (Number(row.revenueInPaisa) > Number(peakSales.revenueInPaisa)) peakSales = row;
  }

  return {
    peakOrdersHour: Number(peakOrders.hour),
    peakOrdersCount: Number(peakOrders.orderCount),
    peakSalesHour: Number(peakSales.hour),
    peakSalesInPaisa: Number(peakSales.revenueInPaisa),
  };
}

export type HourlyHeatmapCell = {
  /** Postgres extract(dow) convention: 0 = Sunday .. 6 = Saturday. */
  dayOfWeek: number;
  /** 0-23, UTC hour-of-day — same simplification as the rest of this file. */
  hour: number;
  orderCount: number;
  revenueInPaisa: number;
};

/**
 * The hour-by-day-of-week grid behind Reports' heatmap — a finer-grained
 * sibling of getPeakHourStats (which only surfaces the single busiest
 * hour). Same scoping as every other query here (completed orders only,
 * bucketed by placedAt's UTC hour), just grouped by day-of-week too so
 * "Friday dinner rush" and "Tuesday lunch" can show up as separate cells
 * instead of collapsing into one "7pm" bucket for the whole range.
 * Sparse by construction — only cells with at least one order are
 * returned; the UI fills the rest of the 7x24 grid with zeros.
 */
export async function getHourlyHeatmap(
  restaurantId: string,
  range: ReportDateRange,
): Promise<HourlyHeatmapCell[]> {
  const { dayStart, dayAfterEnd } = dayBounds(range);

  const rows = await db
    .select({
      dayOfWeek: sql<string>`extract(dow from ${orders.placedAt} at time zone 'UTC')`,
      hour: sql<string>`extract(hour from ${orders.placedAt} at time zone 'UTC')`,
      orderCount: sql<string>`count(*)`,
      revenueInPaisa: sql<string>`coalesce(sum(${orders.totalInPaisa}), 0)`,
    })
    .from(orders)
    .where(
      and(
        eq(orders.restaurantId, restaurantId),
        eq(orders.status, "completed"),
        gte(orders.placedAt, dayStart),
        lt(orders.placedAt, dayAfterEnd),
      ),
    )
    .groupBy(sql`1`, sql`2`);

  return rows.map((row) => ({
    dayOfWeek: Number(row.dayOfWeek),
    hour: Number(row.hour),
    orderCount: Number(row.orderCount),
    revenueInPaisa: Number(row.revenueInPaisa),
  }));
}

export type BranchComparisonRow = {
  branchId: string;
  branchName: string;
  /** The single branch auto-created at onboarding — flagged so the UI can
   *  badge it, same convention as the branch switcher elsewhere. */
  isMain: boolean;
  revenueInPaisa: number;
  orderCount: number;
  averageOrderValueInPaisa: number;
};

/**
 * Per-branch revenue/orders for the range, sorted by revenue descending —
 * lets a multi-branch owner see at a glance which location is carrying the
 * business. Every active branch is included even with zero orders in range
 * (a branch that's gone quiet is itself worth surfacing, not hiding), which
 * is why this starts from `branches` and left-joins sales onto it rather
 * than starting from `orders` and grouping by branchId. Restaurants with
 * exactly one branch (the common case — every restaurant gets one at
 * onboarding even if multi-branch is never used) still get a valid single-row
 * result here; it's up to the caller/UI to decide whether a length-1 result
 * is worth rendering as a "comparison".
 */
export async function getBranchComparison(
  restaurantId: string,
  range: ReportDateRange,
): Promise<BranchComparisonRow[]> {
  const { dayStart, dayAfterEnd } = dayBounds(range);

  const branchRows = await db
    .select({ id: branches.id, name: branches.name, isMain: branches.isMain })
    .from(branches)
    .where(and(eq(branches.restaurantId, restaurantId), eq(branches.isActive, true)))
    .orderBy(asc(branches.createdAt));

  const salesRows = await db
    .select({
      branchId: orders.branchId,
      revenueInPaisa: sql<string>`coalesce(sum(${orders.totalInPaisa}), 0)`,
      orderCount: sql<string>`count(*)`,
    })
    .from(orders)
    .where(
      and(
        eq(orders.restaurantId, restaurantId),
        eq(orders.status, "completed"),
        gte(orders.placedAt, dayStart),
        lt(orders.placedAt, dayAfterEnd),
      ),
    )
    .groupBy(orders.branchId);

  const salesByBranchId = new Map(
    salesRows.map((row) => [
      row.branchId,
      { revenueInPaisa: Number(row.revenueInPaisa), orderCount: Number(row.orderCount) },
    ]),
  );

  return branchRows
    .map((branch) => {
      const sales = salesByBranchId.get(branch.id) ?? { revenueInPaisa: 0, orderCount: 0 };
      return {
        branchId: branch.id,
        branchName: branch.name,
        isMain: branch.isMain,
        revenueInPaisa: sales.revenueInPaisa,
        orderCount: sales.orderCount,
        averageOrderValueInPaisa: computeAverageOrderValueInPaisa(sales.revenueInPaisa, sales.orderCount),
      };
    })
    .sort((a, b) => b.revenueInPaisa - a.revenueInPaisa);
}

export type CompletionStats = {
  /** paid orders / total non-cancelled orders in range, 0–100, 2 decimals. 0 when there are no orders at all (not null — "0 of 0" reads as 0%, not "unknown"). */
  completionRatePercent: number;
  /** Average minutes from orders.placedAt to orders.updatedAt on orders
   *  currently `completed` — an APPROXIMATION of "order → payment/closeout"
   *  time, not an exact one: there's no dedicated completedAt timestamp on
   *  orders (see schema.ts), so this reads updatedAt, which reflects
   *  whichever write most recently touched the row. In the overwhelming
   *  common case that's the status transition into `completed` (see the
   *  order-status route), but a discount/service-charge edit applied AFTER
   *  completion (the adjustments route only blocks cancelled orders, not
   *  completed ones) would also bump it and skew this number. Flagged here
   *  and in PHASE_16_NOTES.md as a known limitation, not silently assumed
   *  precise. Null when there are no completed orders in range.
   */
  avgCompletionMinutes: number | null;
};

export async function getCompletionStats(
  restaurantId: string,
  range: ReportDateRange,
): Promise<CompletionStats> {
  const { dayStart, dayAfterEnd } = dayBounds(range);

  const [totalRow] = await db
    .select({ count: sql<string>`count(*)` })
    .from(orders)
    .where(
      and(
        eq(orders.restaurantId, restaurantId),
        ne(orders.status, "cancelled"),
        gte(orders.placedAt, dayStart),
        lt(orders.placedAt, dayAfterEnd),
      ),
    );

  const [paidRow] = await db
    .select({ count: sql<string>`count(*)` })
    .from(orders)
    .where(
      and(
        eq(orders.restaurantId, restaurantId),
        ne(orders.status, "cancelled"),
        eq(orders.paymentStatus, "paid"),
        gte(orders.placedAt, dayStart),
        lt(orders.placedAt, dayAfterEnd),
      ),
    );

  const [avgRow] = await db
    .select({
      avgMinutes: sql<string | null>`avg(extract(epoch from (${orders.updatedAt} - ${orders.placedAt})) / 60)`,
    })
    .from(orders)
    .where(
      and(
        eq(orders.restaurantId, restaurantId),
        eq(orders.status, "completed"),
        gte(orders.placedAt, dayStart),
        lt(orders.placedAt, dayAfterEnd),
      ),
    );

  const total = Number(totalRow?.count ?? 0);
  const paid = Number(paidRow?.count ?? 0);

  return {
    completionRatePercent: total > 0 ? Math.round((paid / total) * 10000) / 100 : 0,
    avgCompletionMinutes:
      avgRow?.avgMinutes != null ? Math.max(0, Math.round(Number(avgRow.avgMinutes))) : null,
  };
}

export async function getTotalExpensesInPaisa(
  restaurantId: string,
  range: ReportDateRange,
): Promise<number> {
  const [row] = await db
    .select({ totalInPaisa: sql<string>`coalesce(sum(${expenses.amountInPaisa}), 0)` })
    .from(expenses)
    .where(
      and(
        eq(expenses.restaurantId, restaurantId),
        eq(expenses.isVoided, false),
        gte(expenses.expenseDate, range.from),
        lte(expenses.expenseDate, range.to),
      ),
    );
  return Number(row?.totalInPaisa ?? 0);
}

/**
 * One point per calendar day in the range, revenue and expenses both
 * filled to 0 for days with no activity — see mergeDailySeries's own
 * comment for why a real zero shouldn't read as a gap in the chart.
 */
export async function getDailyRevenueVsExpenses(
  restaurantId: string,
  range: ReportDateRange,
): Promise<DailySeriesPoint[]> {
  const { dayStart, dayAfterEnd } = dayBounds(range);

  const revenueRows = await db
    .select({
      day: sql<string>`to_char(${orders.placedAt} at time zone 'UTC', 'YYYY-MM-DD')`,
      revenueInPaisa: sql<string>`coalesce(sum(${orders.totalInPaisa}), 0)`,
    })
    .from(orders)
    .where(
      and(
        eq(orders.restaurantId, restaurantId),
        eq(orders.status, "completed"),
        gte(orders.placedAt, dayStart),
        lt(orders.placedAt, dayAfterEnd),
      ),
    )
    .groupBy(sql`1`);

  const expenseRows = await db
    .select({
      day: expenses.expenseDate,
      totalInPaisa: sql<string>`coalesce(sum(${expenses.amountInPaisa}), 0)`,
    })
    .from(expenses)
    .where(
      and(
        eq(expenses.restaurantId, restaurantId),
        eq(expenses.isVoided, false),
        gte(expenses.expenseDate, range.from),
        lte(expenses.expenseDate, range.to),
      ),
    )
    .groupBy(expenses.expenseDate);

  const revenueByDate = Object.fromEntries(
    revenueRows.map((r) => [r.day, Number(r.revenueInPaisa)]),
  );
  const expensesByDate = Object.fromEntries(
    expenseRows.map((r) => [r.day, Number(r.totalInPaisa)]),
  );

  const dateRange = generateDateRange(range.from, range.to);
  return mergeDailySeries(dateRange, revenueByDate, expensesByDate);
}

export type TopMenuItemRow = {
  name: string;
  quantitySold: number;
  revenueInPaisa: number;
};

/**
 * Ranked by revenue, not quantity — a handful of expensive combo orders
 * matters more to the business than a mountain of Rs 20 add-ons. Grouped
 * by the name SNAPSHOT (menuItemNameSnapshot), not a live join to
 * menu_items, so a since-renamed or deleted item still shows up correctly
 * under the name it had when each historical order was placed.
 */
export async function getTopMenuItems(
  restaurantId: string,
  range: ReportDateRange,
  limit = 10,
): Promise<TopMenuItemRow[]> {
  const { dayStart, dayAfterEnd } = dayBounds(range);

  const rows = await db
    .select({
      name: orderItems.menuItemNameSnapshot,
      quantitySold: sql<string>`sum(${orderItems.quantity})`,
      revenueInPaisa: sql<string>`sum(${orderItems.lineTotalInPaisa})`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .where(
      and(
        eq(orders.restaurantId, restaurantId),
        eq(orders.status, "completed"),
        gte(orders.placedAt, dayStart),
        lt(orders.placedAt, dayAfterEnd),
      ),
    )
    .groupBy(orderItems.menuItemNameSnapshot)
    .orderBy(desc(sql`sum(${orderItems.lineTotalInPaisa})`))
    .limit(limit);

  return rows.map((r) => ({
    name: r.name,
    quantitySold: Number(r.quantitySold),
    revenueInPaisa: Number(r.revenueInPaisa),
  }));
}

export type PaymentBreakdownRow = { method: PaymentMethod; totalInPaisa: number };

/**
 * Sums payments.amountInPaisa, which is already signed (positive
 * payment, negative refund — see schema.ts) — a method's total here is
 * automatically net of any refunds recorded against it in the range, no
 * separate refund subtraction needed.
 */
export async function getPaymentMethodBreakdown(
  restaurantId: string,
  range: ReportDateRange,
): Promise<PaymentBreakdownRow[]> {
  const { dayStart, dayAfterEnd } = dayBounds(range);

  const rows = await db
    .select({
      method: payments.method,
      totalInPaisa: sql<string>`coalesce(sum(${payments.amountInPaisa}), 0)`,
    })
    .from(payments)
    .where(
      and(
        eq(payments.restaurantId, restaurantId),
        gte(payments.createdAt, dayStart),
        lt(payments.createdAt, dayAfterEnd),
      ),
    )
    .groupBy(payments.method)
    .orderBy(desc(sql`sum(${payments.amountInPaisa})`));

  return rows.map((r) => ({ method: r.method as PaymentMethod, totalInPaisa: Number(r.totalInPaisa) }));
}

export type ExpenseBreakdownRow = { category: ExpenseCategory; totalInPaisa: number };

export async function getExpenseCategoryBreakdown(
  restaurantId: string,
  range: ReportDateRange,
): Promise<ExpenseBreakdownRow[]> {
  const rows = await db
    .select({
      category: expenses.category,
      totalInPaisa: sql<string>`coalesce(sum(${expenses.amountInPaisa}), 0)`,
    })
    .from(expenses)
    .where(
      and(
        eq(expenses.restaurantId, restaurantId),
        eq(expenses.isVoided, false),
        gte(expenses.expenseDate, range.from),
        lte(expenses.expenseDate, range.to),
      ),
    )
    .groupBy(expenses.category)
    .orderBy(desc(sql`sum(${expenses.amountInPaisa})`));

  return rows.map((r) => ({ category: r.category as ExpenseCategory, totalInPaisa: Number(r.totalInPaisa) }));
}

/**
 * The single call the reports API route makes — bundles every section of
 * the report into one payload so the dashboard page is one request, not
 * five, and every number on the page is guaranteed to reflect the exact
 * same date range (no risk of two sections racing against slightly
 * different "now" boundaries on separate requests).
 */
export type PeriodComparison = {
  /** The immediately-preceding, same-length period this range was compared against. */
  previousRange: ReportDateRange;
  /** % change vs previous period, or null when the previous period had a
   *  zero baseline (see percentChange()'s doc comment — "New" in the UI,
   *  not a misleading number). */
  revenueChangePercent: number | null;
  ordersChangePercent: number | null;
  avgOrderValueChangePercent: number | null;
  netProfitChangePercent: number | null;
};

export async function getReportSummary(restaurantId: string, range: ReportDateRange) {
  const [
    sales,
    totalExpensesInPaisa,
    dailySeries,
    topItems,
    paymentBreakdown,
    expenseBreakdown,
    tips,
    peakHour,
    completion,
    hourlyHeatmap,
    branchComparison,
  ] = await Promise.all([
    getSalesSummary(restaurantId, range),
    getTotalExpensesInPaisa(restaurantId, range),
    getDailyRevenueVsExpenses(restaurantId, range),
    getTopMenuItems(restaurantId, range),
    getPaymentMethodBreakdown(restaurantId, range),
    getExpenseCategoryBreakdown(restaurantId, range),
    getTipsSummary(restaurantId, range),
    getPeakHourStats(restaurantId, range),
    getCompletionStats(restaurantId, range),
    getHourlyHeatmap(restaurantId, range),
    getBranchComparison(restaurantId, range),
  ]);

  const netProfitInPaisa = computeNetProfitInPaisa(sales.revenueInPaisa, totalExpensesInPaisa);

  // Phase 16b — "vs previous period" deltas for the KPI tiles, requested
  // directly by the user (the reference dashboard they sent shows a "+8.43%
  // vs last month" pill on its Orders tile). Fetched as a second round trip
  // rather than folded into the Promise.all above so the previous period's
  // getSalesSummary/getTotalExpensesInPaisa calls can run in parallel with
  // each other without complicating the primary batch above.
  const previousRange = previousPeriodRange(range);
  const [previousSales, previousExpensesInPaisa] = await Promise.all([
    getSalesSummary(restaurantId, previousRange),
    getTotalExpensesInPaisa(restaurantId, previousRange),
  ]);
  const previousNetProfitInPaisa = computeNetProfitInPaisa(
    previousSales.revenueInPaisa,
    previousExpensesInPaisa,
  );

  const comparison: PeriodComparison = {
    previousRange,
    revenueChangePercent: percentChange(sales.revenueInPaisa, previousSales.revenueInPaisa),
    ordersChangePercent: percentChange(sales.orderCount, previousSales.orderCount),
    avgOrderValueChangePercent: percentChange(
      sales.averageOrderValueInPaisa,
      previousSales.averageOrderValueInPaisa,
    ),
    netProfitChangePercent: percentChange(netProfitInPaisa, previousNetProfitInPaisa),
  };

  return {
    range,
    sales,
    totalExpensesInPaisa,
    netProfitInPaisa,
    dailySeries,
    topItems,
    paymentBreakdown,
    expenseBreakdown,
    totalTipsInPaisa: tips.totalTipsInPaisa,
    peakHour,
    completion,
    comparison,
    hourlyHeatmap,
    branchComparison,
  };
}
