import "server-only";
import { and, asc, desc, eq, gte, isNotNull, lt, lte, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, type Database, type Transaction } from "@/db";
import {
  orders,
  orderItems,
  payments,
  expenses,
  expenseCategories,
  branches,
  recipeItems,
  inventoryItems,
  stockMovements,
  orderStatusHistory,
  users,
} from "@/db/schema";
import type { WasteReasonValue } from "@/lib/waste-reasons";
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
import { restaurantStartOfDay } from "@/lib/restaurant-date";
import type { OrderStatus } from "@/lib/order-status";

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
 * never ambiguously included/excluded. `range.from`/`range.to` are
 * calendar days in the RESTAURANT's own timezone (restaurants.timezone —
 * see restaurant-date.ts), not UTC's — a restaurant on Asia/Kathmandu
 * (UTC+5:45) asking for "today" means its own midnight-to-midnight, which
 * is 18:15 UTC the previous day to 18:15 UTC today, not literal UTC
 * midnight.
 */
function dayBounds(range: ReportDateRange, timezone: string) {
  const dayStart = restaurantStartOfDay(timezone, range.from);
  const dayAfterEnd = new Date(restaurantStartOfDay(timezone, range.to).getTime() + 24 * 60 * 60 * 1000);
  return { dayStart, dayAfterEnd };
}

export async function getSalesSummary(
  restaurantId: string,
  range: ReportDateRange,
  timezone: string,
  branchId?: string,
  // QA hardening pass (Daily Closing transactionality) — every function in
  // this module now accepts the querying connection as an optional final
  // parameter, defaulting to the module-level `db` so every OTHER existing
  // caller (the Reports dashboard, the AI assistant, dashboard-summary,
  // etc.) is completely unaffected. Daily Closing is the one caller that
  // passes its own open transaction, so the entire snapshot it persists is
  // computed from ONE consistent, transactionally-isolated view of the
  // database rather than several independent connections racing whatever
  // mutations happen to land mid-computation. See daily-closing.ts's own
  // comment on closeDailyBusiness for the full rationale.
  dbOrTx: Database | Transaction = db,
) {
  const { dayStart, dayAfterEnd } = dayBounds(range, timezone);

  const [completedRow] = await dbOrTx
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
        ...(branchId ? [eq(orders.branchId, branchId)] : []),
      ),
    );

  const [cancelledRow] = await dbOrTx
    .select({ count: sql<string>`count(*)` })
    .from(orders)
    .where(
      and(
        eq(orders.restaurantId, restaurantId),
        eq(orders.status, "cancelled"),
        gte(orders.placedAt, dayStart),
        lt(orders.placedAt, dayAfterEnd),
        ...(branchId ? [eq(orders.branchId, branchId)] : []),
      ),
    );

  // RC audit P1 fix — there is no "refunded"/"voided" order status
  // (`completed` is terminal, see order-status.ts); a refund only ever
  // touches `orders.paymentStatus`, never `orders.status`. Without this,
  // a fully (or partially) refunded completed order would still count its
  // full `totalInPaisa` as revenue forever — refunds are stored as
  // negative-amount `payments` rows (see the refunds route's own doc
  // comment), so they net out correctly in getPaymentMethodBreakdown
  // (which sums raw payments directly) but nowhere else. Scoped by the
  // ORDER's placedAt, not the refund's own createdAt — same as
  // revenueInPaisa itself — so a refund issued on a later day still
  // reduces the revenue attributed to the day the sale was made, matching
  // this function's accrual-style "revenue" definition (see the module
  // doc comment above).
  const [refundRow] = await dbOrTx
    .select({
      netRefundInPaisa: sql<string>`
        coalesce(sum(case when ${payments.amountInPaisa} < 0 then -${payments.amountInPaisa} else 0 end), 0)
      `,
    })
    .from(payments)
    .innerJoin(orders, eq(payments.orderId, orders.id))
    .where(
      and(
        eq(orders.restaurantId, restaurantId),
        eq(orders.status, "completed"),
        gte(orders.placedAt, dayStart),
        lt(orders.placedAt, dayAfterEnd),
        ...(branchId ? [eq(orders.branchId, branchId)] : []),
      ),
    );

  const grossRevenueInPaisa = Number(completedRow?.revenueInPaisa ?? 0);
  const netRefundInPaisa = Number(refundRow?.netRefundInPaisa ?? 0);
  // Clamped at 0 rather than allowed to go negative — refunds are bounded
  // by net-paid-so-far at the point they're recorded (see the refunds
  // route), never by totalInPaisa, so an order that was overpaid and then
  // fully refunded could in principle refund more than its own total; that
  // shouldn't read as "negative revenue" on a report.
  const revenueInPaisa = Math.max(0, grossRevenueInPaisa - netRefundInPaisa);
  const orderCount = Number(completedRow?.orderCount ?? 0);

  return {
    revenueInPaisa,
    orderCount,
    averageOrderValueInPaisa: computeAverageOrderValueInPaisa(revenueInPaisa, orderCount),
    cancelledCount: Number(cancelledRow?.count ?? 0),
    discountInPaisa: Number(completedRow?.discountInPaisa ?? 0),
    serviceChargeInPaisa: Number(completedRow?.serviceChargeInPaisa ?? 0),
    // Commercial-launch Daily Closing (Phase A.2) needs this as its own
    // line item ("Refunds") — it was already computed above to net
    // revenueInPaisa down, just not previously exposed to callers.
    refundInPaisa: netRefundInPaisa,
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
  timezone: string,
  branchId?: string,
  dbOrTx: Database | Transaction = db,
): Promise<{ totalTipsInPaisa: number }> {
  const { dayStart, dayAfterEnd } = dayBounds(range, timezone);

  // payments has no branchId column of its own (see schema.ts) — every
  // payment belongs to exactly one order (orderId is NOT NULL), so an
  // inner join onto orders.branchId is how branch scoping applies here.
  // Joining unconditionally (rather than only when branchId is passed)
  // keeps this one query shape instead of two, and changes nothing about
  // the result when branchId is omitted — payments.orderId always
  // resolves to exactly one order row, so the join can't drop or
  // duplicate a payment.
  const [row] = await dbOrTx
    .select({ totalTipsInPaisa: sql<string>`coalesce(sum(${payments.tipInPaisa}), 0)` })
    .from(payments)
    .innerJoin(orders, eq(payments.orderId, orders.id))
    .where(
      and(
        eq(payments.restaurantId, restaurantId),
        gte(payments.createdAt, dayStart),
        lt(payments.createdAt, dayAfterEnd),
        ...(branchId ? [eq(orders.branchId, branchId)] : []),
      ),
    );

  return { totalTipsInPaisa: Number(row?.totalTipsInPaisa ?? 0) };
}

export type PeakHourStats = {
  /** 0–23, the restaurant's own local hour-of-day (restaurants.timezone —
   *  see dayBounds's comment). Null when there are no completed orders in
   *  range at all. */
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
 * bucketed by orders.placedAt's LOCAL (restaurant-timezone) hour-of-day,
 * summed across every day in the range (i.e. "which hour tends to be
 * busiest," not a single day's hour-by-hour breakdown).
 */
export async function getPeakHourStats(
  restaurantId: string,
  range: ReportDateRange,
  timezone: string,
  branchId?: string,
  dbOrTx: Database | Transaction = db,
): Promise<PeakHourStats> {
  const { dayStart, dayAfterEnd } = dayBounds(range, timezone);

  const rows = await dbOrTx
    .select({
      hour: sql<string>`extract(hour from ${orders.placedAt} at time zone ${timezone})`,
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
        ...(branchId ? [eq(orders.branchId, branchId)] : []),
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
  /** Postgres extract(dow) convention: 0 = Sunday .. 6 = Saturday, computed
   *  in the restaurant's own local timezone (so a 12:30am order reads as
   *  the day staff actually experienced it as, not UTC's day). */
  dayOfWeek: number;
  /** 0-23, the restaurant's own local hour-of-day. */
  hour: number;
  orderCount: number;
  revenueInPaisa: number;
};

/**
 * The hour-by-day-of-week grid behind Reports' heatmap — a finer-grained
 * sibling of getPeakHourStats (which only surfaces the single busiest
 * hour). Same scoping as every other query here (completed orders only,
 * bucketed by placedAt's LOCAL hour), just grouped by day-of-week too so
 * "Friday dinner rush" and "Tuesday lunch" can show up as separate cells
 * instead of collapsing into one "7pm" bucket for the whole range.
 * Sparse by construction — only cells with at least one order are
 * returned; the UI fills the rest of the 7x24 grid with zeros.
 */
export async function getHourlyHeatmap(
  restaurantId: string,
  range: ReportDateRange,
  timezone: string,
  branchId?: string,
  dbOrTx: Database | Transaction = db,
): Promise<HourlyHeatmapCell[]> {
  const { dayStart, dayAfterEnd } = dayBounds(range, timezone);

  const rows = await dbOrTx
    .select({
      dayOfWeek: sql<string>`extract(dow from ${orders.placedAt} at time zone ${timezone})`,
      hour: sql<string>`extract(hour from ${orders.placedAt} at time zone ${timezone})`,
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
        ...(branchId ? [eq(orders.branchId, branchId)] : []),
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
  timezone: string,
  dbOrTx: Database | Transaction = db,
): Promise<BranchComparisonRow[]> {
  const { dayStart, dayAfterEnd } = dayBounds(range, timezone);

  const branchRows = await dbOrTx
    .select({ id: branches.id, name: branches.name, isMain: branches.isMain })
    .from(branches)
    .where(and(eq(branches.restaurantId, restaurantId), eq(branches.isActive, true)))
    .orderBy(asc(branches.createdAt));

  const salesRows = await dbOrTx
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
  timezone: string,
  branchId?: string,
  dbOrTx: Database | Transaction = db,
): Promise<CompletionStats> {
  const { dayStart, dayAfterEnd } = dayBounds(range, timezone);

  const [totalRow] = await dbOrTx
    .select({ count: sql<string>`count(*)` })
    .from(orders)
    .where(
      and(
        eq(orders.restaurantId, restaurantId),
        ne(orders.status, "cancelled"),
        gte(orders.placedAt, dayStart),
        lt(orders.placedAt, dayAfterEnd),
        ...(branchId ? [eq(orders.branchId, branchId)] : []),
      ),
    );

  const [paidRow] = await dbOrTx
    .select({ count: sql<string>`count(*)` })
    .from(orders)
    .where(
      and(
        eq(orders.restaurantId, restaurantId),
        ne(orders.status, "cancelled"),
        eq(orders.paymentStatus, "paid"),
        gte(orders.placedAt, dayStart),
        lt(orders.placedAt, dayAfterEnd),
        ...(branchId ? [eq(orders.branchId, branchId)] : []),
      ),
    );

  const [avgRow] = await dbOrTx
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
        ...(branchId ? [eq(orders.branchId, branchId)] : []),
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

// ---------------------------------------------------------------------------
// Order Performance (Commercial Launch Phase B.1) — stage durations built
// from order_status_history (see that table's own doc comment in schema.ts
// for why it exists as a structured sibling of audit_logs). This is a more
// precise successor to getCompletionStats' avgCompletionMinutes above
// (which proxies "completion time" off orders.updatedAt — a column any
// edit can touch, not just a status change); that stat is left as-is for
// backward compatibility, this is additive.
// ---------------------------------------------------------------------------

function minutesOrNull(value: string | null | undefined): number | null {
  return value != null ? Math.max(0, Math.round(Number(value))) : null;
}

export type OrderStageDurationRow = {
  fromStatus: OrderStatus;
  toStatus: OrderStatus;
  avgMinutes: number | null;
  transitionCount: number;
};

/** The five real forward stages a non-cancelled order passes through — see order-status.ts's TRANSITIONS. */
const ORDER_STAGE_PAIRS: Array<[OrderStatus, OrderStatus]> = [
  ["pending", "confirmed"],
  ["confirmed", "preparing"],
  ["preparing", "ready"],
  ["ready", "served"],
  ["served", "completed"],
];

/**
 * Average time an order spends in `fromStatus` before moving to `toStatus`,
 * scoped/filtered the same way as every other report here (orders.placedAt
 * in range, optional branch). `fromStatus === "pending"` is special-cased:
 * there is no history row for "entering pending" (see the table's own doc
 * comment — orders.placedAt already IS that moment), so that one stage
 * measures from placedAt instead of a self-joined prior row. Every other
 * stage self-joins order_status_history to itself: `entered` is the row
 * where the order arrived at `fromStatus`, `arrived` is the row where it
 * left `fromStatus` for `toStatus`.
 */
async function getStageDuration(
  restaurantId: string,
  fromStatus: OrderStatus,
  toStatus: OrderStatus,
  dayStart: Date,
  dayAfterEnd: Date,
  branchId?: string,
  dbOrTx: Database | Transaction = db,
): Promise<OrderStageDurationRow> {
  const arrived = alias(orderStatusHistory, "arrived");

  if (fromStatus === "pending") {
    const [row] = await dbOrTx
      .select({
        avgMinutes: sql<string | null>`avg(extract(epoch from (${arrived.changedAt} - ${orders.placedAt})) / 60)`,
        transitionCount: sql<string>`count(*)`,
      })
      .from(arrived)
      .innerJoin(orders, eq(arrived.orderId, orders.id))
      .where(
        and(
          eq(arrived.restaurantId, restaurantId),
          eq(arrived.toStatus, toStatus),
          gte(orders.placedAt, dayStart),
          lt(orders.placedAt, dayAfterEnd),
          ...(branchId ? [eq(orders.branchId, branchId)] : []),
        ),
      );
    return {
      fromStatus,
      toStatus,
      avgMinutes: minutesOrNull(row?.avgMinutes),
      transitionCount: Number(row?.transitionCount ?? 0),
    };
  }

  const entered = alias(orderStatusHistory, "entered");
  const [row] = await dbOrTx
    .select({
      avgMinutes: sql<string | null>`avg(extract(epoch from (${arrived.changedAt} - ${entered.changedAt})) / 60)`,
      transitionCount: sql<string>`count(*)`,
    })
    .from(arrived)
    .innerJoin(entered, and(eq(entered.orderId, arrived.orderId), eq(entered.toStatus, fromStatus)))
    .innerJoin(orders, eq(arrived.orderId, orders.id))
    .where(
      and(
        eq(arrived.restaurantId, restaurantId),
        eq(arrived.toStatus, toStatus),
        gte(orders.placedAt, dayStart),
        lt(orders.placedAt, dayAfterEnd),
        ...(branchId ? [eq(orders.branchId, branchId)] : []),
      ),
    );
  return {
    fromStatus,
    toStatus,
    avgMinutes: minutesOrNull(row?.avgMinutes),
    transitionCount: Number(row?.transitionCount ?? 0),
  };
}

export type CancellationReasonRow = { reason: string; count: number };

/**
 * Commercial completion pass — Order Performance Analytics gap (the P1
 * verification pass found stage-duration/cancellation analytics already
 * built, but no table-turn-time or per-staff throughput). One row per
 * staff member who completed at least one order in range — ordered by
 * completedOrders desc, capped so a restaurant with a large/high-turnover
 * roster can't return an unbounded list.
 */
export type StaffThroughputRow = {
  userId: string;
  staffName: string;
  completedOrders: number;
  revenueInPaisa: number;
};

const STAFF_THROUGHPUT_LIMIT = 50;

export type OrderPerformanceStats = {
  /** In stage order: pending->confirmed, confirmed->preparing, preparing->ready, ready->served, served->completed. */
  stageDurations: OrderStageDurationRow[];
  cancelledCount: number;
  /** cancelled / all orders placed in range, as a percent. */
  cancellationRatePercent: number;
  /** Average time from placedAt to the cancellation transition. */
  avgMinutesBeforeCancellation: number | null;
  /** Most-cancelled reason first. "No reason given" groups every cancellation with a null reason. */
  cancellationReasons: CancellationReasonRow[];
  /**
   * Average minutes from placedAt to the ->completed transition, for
   * dine-in orders only (orders.tableId IS NOT NULL) — "how long a table
   * was occupied by one dining party," the standard restaurant meaning of
   * table-turn time. Null when no dine-in order completed in range.
   */
  avgTableTurnMinutes: number | null;
  /** Which staff member completed how many orders (and how much revenue), most-active first. */
  staffThroughput: StaffThroughputRow[];
};

export async function getOrderPerformanceStats(
  restaurantId: string,
  range: ReportDateRange,
  timezone: string,
  branchId?: string,
  dbOrTx: Database | Transaction = db,
): Promise<OrderPerformanceStats> {
  const { dayStart, dayAfterEnd } = dayBounds(range, timezone);

  const branchFilter = branchId ? [eq(orders.branchId, branchId)] : [];

  const [stageDurations, [totalRow], [cancelledRow], [cancelledAvgRow], reasonRows, [tableTurnRow], staffRows] =
    await Promise.all([
    Promise.all(
      ORDER_STAGE_PAIRS.map(([from, to]) =>
        getStageDuration(restaurantId, from, to, dayStart, dayAfterEnd, branchId, dbOrTx),
      ),
    ),
    dbOrTx
      .select({ count: sql<string>`count(*)` })
      .from(orders)
      .where(
        and(
          eq(orders.restaurantId, restaurantId),
          gte(orders.placedAt, dayStart),
          lt(orders.placedAt, dayAfterEnd),
          ...branchFilter,
        ),
      ),
    dbOrTx
      .select({ count: sql<string>`count(*)` })
      .from(orders)
      .where(
        and(
          eq(orders.restaurantId, restaurantId),
          eq(orders.status, "cancelled"),
          gte(orders.placedAt, dayStart),
          lt(orders.placedAt, dayAfterEnd),
          ...branchFilter,
        ),
      ),
    dbOrTx
      .select({
        avgMinutes: sql<string | null>`avg(extract(epoch from (${orderStatusHistory.changedAt} - ${orders.placedAt})) / 60)`,
      })
      .from(orderStatusHistory)
      .innerJoin(orders, eq(orderStatusHistory.orderId, orders.id))
      .where(
        and(
          eq(orderStatusHistory.restaurantId, restaurantId),
          eq(orderStatusHistory.toStatus, "cancelled"),
          gte(orders.placedAt, dayStart),
          lt(orders.placedAt, dayAfterEnd),
          ...branchFilter,
        ),
      ),
    dbOrTx
      .select({
        reason: sql<string>`coalesce(${orderStatusHistory.reason}, 'No reason given')`,
        count: sql<string>`count(*)`,
      })
      .from(orderStatusHistory)
      .innerJoin(orders, eq(orderStatusHistory.orderId, orders.id))
      .where(
        and(
          eq(orderStatusHistory.restaurantId, restaurantId),
          eq(orderStatusHistory.toStatus, "cancelled"),
          gte(orders.placedAt, dayStart),
          lt(orders.placedAt, dayAfterEnd),
          ...branchFilter,
        ),
      )
      .groupBy(sql`1`)
      .orderBy(desc(sql`count(*)`)),
    // Table-turn time: placedAt -> ->completed transition, dine-in orders
    // only (tableId IS NOT NULL). Same shape as the cancellation-avg query
    // above, just scoped to toStatus "completed" and dine-in.
    dbOrTx
      .select({
        avgMinutes: sql<string | null>`avg(extract(epoch from (${orderStatusHistory.changedAt} - ${orders.placedAt})) / 60)`,
      })
      .from(orderStatusHistory)
      .innerJoin(orders, eq(orderStatusHistory.orderId, orders.id))
      .where(
        and(
          eq(orderStatusHistory.restaurantId, restaurantId),
          eq(orderStatusHistory.toStatus, "completed"),
          isNotNull(orders.tableId),
          gte(orders.placedAt, dayStart),
          lt(orders.placedAt, dayAfterEnd),
          ...branchFilter,
        ),
      ),
    // Per-staff throughput: who actually clicked "completed," how many
    // times, and what revenue those orders represent. changedByUserId is
    // nullable (a completion with no attributable actor, e.g. a very old
    // pre-audit row) — excluded via the inner join to users rather than
    // shown as a misleading "unknown staff" bucket.
    dbOrTx
      .select({
        userId: orderStatusHistory.changedByUserId,
        staffName: users.fullName,
        completedOrders: sql<string>`count(*)`,
        revenueInPaisa: sql<string>`coalesce(sum(${orders.totalInPaisa}), 0)`,
      })
      .from(orderStatusHistory)
      .innerJoin(orders, eq(orderStatusHistory.orderId, orders.id))
      .innerJoin(users, eq(orderStatusHistory.changedByUserId, users.id))
      .where(
        and(
          eq(orderStatusHistory.restaurantId, restaurantId),
          eq(orderStatusHistory.toStatus, "completed"),
          gte(orders.placedAt, dayStart),
          lt(orders.placedAt, dayAfterEnd),
          ...branchFilter,
        ),
      )
      .groupBy(orderStatusHistory.changedByUserId, users.fullName)
      .orderBy(desc(sql`count(*)`))
      .limit(STAFF_THROUGHPUT_LIMIT),
  ]);

  const total = Number(totalRow?.count ?? 0);
  const cancelledCount = Number(cancelledRow?.count ?? 0);

  return {
    stageDurations,
    cancelledCount,
    cancellationRatePercent: total > 0 ? Math.round((cancelledCount / total) * 10000) / 100 : 0,
    avgMinutesBeforeCancellation: minutesOrNull(cancelledAvgRow?.avgMinutes),
    cancellationReasons: reasonRows.map((r) => ({ reason: r.reason, count: Number(r.count) })),
    avgTableTurnMinutes: minutesOrNull(tableTurnRow?.avgMinutes),
    staffThroughput: staffRows
      .filter((r): r is typeof r & { userId: string } => r.userId !== null)
      .map((r) => ({
        userId: r.userId,
        staffName: r.staffName,
        completedOrders: Number(r.completedOrders),
        revenueInPaisa: Number(r.revenueInPaisa),
      })),
  };
}

export async function getTotalExpensesInPaisa(
  restaurantId: string,
  range: ReportDateRange,
  // Not used for the date comparison below — expenses.expenseDate is
  // already a plain restaurant-local calendar date (see the expenses
  // route's own use of restaurantDate()), so no UTC conversion is needed
  // here. Accepted anyway to keep this function's signature consistent
  // with the rest of the module, all of which getReportSummary calls
  // uniformly.
  _timezone: string,
  branchId?: string,
  dbOrTx: Database | Transaction = db,
): Promise<number> {
  const [row] = await dbOrTx
    .select({ totalInPaisa: sql<string>`coalesce(sum(${expenses.amountInPaisa}), 0)` })
    .from(expenses)
    .where(
      and(
        eq(expenses.restaurantId, restaurantId),
        eq(expenses.isVoided, false),
        // Phase 21 — only PAID expenses are real cash-out; a
        // pending_approval/approved expense hasn't actually been paid yet
        // (and has no matching ledger debit — see the /pay route), so
        // counting it here would make this number disagree with Account
        // Books (spec section 42: summaries must reconcile with the
        // underlying transactions).
        eq(expenses.status, "paid"),
        gte(expenses.expenseDate, range.from),
        lte(expenses.expenseDate, range.to),
        // expenses.branchId is nullable (an expense can be restaurant-wide
        // overhead, not tied to any one location) — a branch-scoped view
        // only shows expenses explicitly recorded against that branch, not
        // shared overhead, same as how a branch's own P&L wouldn't
        // normally absorb head-office costs unless someone allocates them.
        ...(branchId ? [eq(expenses.branchId, branchId)] : []),
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
  timezone: string,
  branchId?: string,
  dbOrTx: Database | Transaction = db,
): Promise<DailySeriesPoint[]> {
  const { dayStart, dayAfterEnd } = dayBounds(range, timezone);

  const revenueRows = await dbOrTx
    .select({
      day: sql<string>`to_char(${orders.placedAt} at time zone ${timezone}, 'YYYY-MM-DD')`,
      revenueInPaisa: sql<string>`coalesce(sum(${orders.totalInPaisa}), 0)`,
    })
    .from(orders)
    .where(
      and(
        eq(orders.restaurantId, restaurantId),
        eq(orders.status, "completed"),
        gte(orders.placedAt, dayStart),
        lt(orders.placedAt, dayAfterEnd),
        ...(branchId ? [eq(orders.branchId, branchId)] : []),
      ),
    )
    .groupBy(sql`1`);

  const expenseRows = await dbOrTx
    .select({
      day: expenses.expenseDate,
      totalInPaisa: sql<string>`coalesce(sum(${expenses.amountInPaisa}), 0)`,
    })
    .from(expenses)
    .where(
      and(
        eq(expenses.restaurantId, restaurantId),
        eq(expenses.isVoided, false),
        eq(expenses.status, "paid"),
        gte(expenses.expenseDate, range.from),
        lte(expenses.expenseDate, range.to),
        // See getTotalExpensesInPaisa's comment on why branchId=null
        // expenses (shared overhead) drop out of a branch-scoped view.
        ...(branchId ? [eq(expenses.branchId, branchId)] : []),
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
  timezone: string,
  limit = 10,
  branchId?: string,
  dbOrTx: Database | Transaction = db,
): Promise<TopMenuItemRow[]> {
  const { dayStart, dayAfterEnd } = dayBounds(range, timezone);

  const rows = await dbOrTx
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
        ...(branchId ? [eq(orders.branchId, branchId)] : []),
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
  timezone: string,
  branchId?: string,
  dbOrTx: Database | Transaction = db,
): Promise<PaymentBreakdownRow[]> {
  const { dayStart, dayAfterEnd } = dayBounds(range, timezone);

  // Same unconditional join-to-orders rationale as getTipsSummary above —
  // payments has no branchId of its own.
  const rows = await dbOrTx
    .select({
      method: payments.method,
      totalInPaisa: sql<string>`coalesce(sum(${payments.amountInPaisa}), 0)`,
    })
    .from(payments)
    .innerJoin(orders, eq(payments.orderId, orders.id))
    .where(
      and(
        eq(payments.restaurantId, restaurantId),
        gte(payments.createdAt, dayStart),
        lt(payments.createdAt, dayAfterEnd),
        ...(branchId ? [eq(orders.branchId, branchId)] : []),
      ),
    )
    .groupBy(payments.method)
    .orderBy(desc(sql`sum(${payments.amountInPaisa})`));

  return rows.map((r) => ({ method: r.method as PaymentMethod, totalInPaisa: Number(r.totalInPaisa) }));
}

/** category is the category's display NAME (Phase 21 — categories are a
 * per-restaurant table now, not a fixed enum, so there's no fixed type to
 * key this by; see expense-categories.ts). */
export type ExpenseBreakdownRow = { category: string; totalInPaisa: number };

export async function getExpenseCategoryBreakdown(
  restaurantId: string,
  range: ReportDateRange,
  // See getTotalExpensesInPaisa's comment — not used here either, kept for
  // signature consistency across this module.
  _timezone: string,
  branchId?: string,
  dbOrTx: Database | Transaction = db,
): Promise<ExpenseBreakdownRow[]> {
  const rows = await dbOrTx
    .select({
      category: expenseCategories.name,
      totalInPaisa: sql<string>`coalesce(sum(${expenses.amountInPaisa}), 0)`,
    })
    .from(expenses)
    .innerJoin(expenseCategories, eq(expenseCategories.id, expenses.categoryId))
    .where(
      and(
        eq(expenses.restaurantId, restaurantId),
        eq(expenses.isVoided, false),
        eq(expenses.status, "paid"),
        gte(expenses.expenseDate, range.from),
        lte(expenses.expenseDate, range.to),
        // See getTotalExpensesInPaisa's comment on why branchId=null
        // expenses (shared overhead) drop out of a branch-scoped view.
        ...(branchId ? [eq(expenses.branchId, branchId)] : []),
      ),
    )
    .groupBy(expenseCategories.name)
    .orderBy(desc(sql`sum(${expenses.amountInPaisa})`));

  return rows.map((r) => ({ category: r.category, totalInPaisa: Number(r.totalInPaisa) }));
}

/**
 * Excludes order_items belonging to a FULLY refunded order (net payments
 * <= 0 AND at least one refund recorded — see the payments-vs-revenue
 * comment on getSalesSummary for why net-paid, not orders.status, is the
 * signal). Shared by getCogsSummary and getProductProfitability so a
 * line's revenue and its COGS always agree on which orders count — see
 * getCogsSummary's own comment for the partial-refund caveat (not handled
 * here either, for the same reason: no line-item link between a refund and
 * specific order_items to prorate against).
 */
function excludeFullyRefundedOrders() {
  return sql`NOT EXISTS (
    SELECT 1 FROM ${payments}
    WHERE ${payments.orderId} = ${orders.id}
    GROUP BY ${payments.orderId}
    HAVING SUM(${payments.amountInPaisa}) <= 0
       AND SUM(CASE WHEN ${payments.amountInPaisa} < 0 THEN 1 ELSE 0 END) > 0
  )`;
}

export type CogsSummary = {
  cogsInPaisa: number;
  /** How many distinct menu items sold in this range actually had a
   *  matching recipe (see below) — surfaced so the UI can be honest about
   *  when cogsInPaisa is a genuine total vs. a partial one. */
  itemsWithRecipeCount: number;
  /** Distinct menu items sold in this range, recipe or not. Equal to
   *  itemsWithRecipeCount when every sold item has a recipe defined. */
  soldItemCount: number;
};

/**
 * P2 — cost of goods sold, derived from recipeItems (bill-of-materials per
 * menu item) x inventoryItems.costPerUnitInPaisa (weighted-average cost),
 * applied to every completed order's line items in the range. Deliberately
 * NOT folded into netProfitInPaisa/computeNetProfitInPaisa above — those
 * are revenue-minus-manually-logged-EXPENSES, an existing, already-tested
 * definition (Account Books' own model, see ledgerEntries' module
 * comment). An owner who buys ingredients without ever touching the
 * Recipes/Purchases feature may already be logging that cost manually as
 * an "Inventory"/"Food ingredients" expense — folding COGS into
 * netProfitInPaisa too would silently double-count that spend for exactly
 * the owners least likely to notice (the ones NOT using recipes). Gross
 * profit (revenue - COGS) is surfaced as its own, clearly-separate figure
 * instead — see getReportSummary below and BRANCH_INVENTORY.md's sibling
 * COGS write-up for the full reasoning.
 *
 * A menu item with no recipe defined contributes 0 to cogsInPaisa for
 * every unit sold — recipes are opt-in (same convention
 * deductRecipeStockForOrder already uses for stock deduction), so this is
 * silently a PARTIAL total whenever any sold item lacks a recipe, which
 * itemsWithRecipeCount/soldItemCount exist to make visible rather than
 * hide behind a single confident-looking number.
 *
 * The per-line cost formula — Math.round((quantityPerServingMilliunits /
 * 1000) * costPerUnitInPaisa) per unit sold, summed — matches the recipe
 * detail route's own lineCostInPaisa/costPerServingInPaisa exactly (see
 * the recipe route's GET handler), so a menu item's "cost per serving"
 * shown there and its contribution to this report's COGS always agree.
 * Done as one rounded SUM in SQL rather than per-line in JS since this is
 * a management report, not a financial transaction that must reconcile to
 * the exact paisa (unlike a payment or purchase line total) — a
 * rounding difference of a paisa or two across many order lines is
 * immaterial here.
 *
 * Phase A.4 — each line PREFERS orderItems.recipeCostInPaisa, the frozen
 * snapshot written by deductRecipeStockForOrder at the moment stock was
 * actually deducted (see that function's own comment for why: costPerUnit
 * is a live weighted average, so recomputing an old order's COGS from
 * TODAY's cost would silently misstate history). Only when that snapshot
 * is NULL — an order placed before this column existed, or an item that
 * genuinely had no recipe at deduction time — does this fall back to the
 * live recipeItems/inventoryItems join, i.e. exactly the query this
 * function ran before Phase A.4. Postgres's COALESCE short-circuits (per
 * its own docs: arguments after the first non-null aren't evaluated), so
 * the correlated subquery below only runs for that shrinking minority of
 * rows, not for every line.
 */
export async function getCogsSummary(
  restaurantId: string,
  range: ReportDateRange,
  timezone: string,
  branchId?: string,
  dbOrTx: Database | Transaction = db,
): Promise<CogsSummary> {
  const { dayStart, dayAfterEnd } = dayBounds(range, timezone);

  const liveRecipeCostSubquery = sql`(
    SELECT round(sum(${orderItems.quantity} * ${recipeItems.quantityPerServingMilliunits} * ${inventoryItems.costPerUnitInPaisa}) / 1000.0)
    FROM ${recipeItems}
    INNER JOIN ${inventoryItems} ON ${inventoryItems.id} = ${recipeItems.inventoryItemId}
    WHERE ${recipeItems.menuItemId} = ${orderItems.menuItemId}
  )`;
  const hasRecipeNowSubquery = sql`EXISTS (SELECT 1 FROM ${recipeItems} WHERE ${recipeItems.menuItemId} = ${orderItems.menuItemId})`;

  const [row] = await dbOrTx
    .select({
      cogsInPaisa: sql<string>`
        coalesce(sum(coalesce(${orderItems.recipeCostInPaisa}, ${liveRecipeCostSubquery}, 0)), 0)
      `,
      soldItemCount: sql<string>`count(distinct ${orderItems.menuItemId})`,
      itemsWithRecipeCount: sql<string>`
        count(distinct case when ${orderItems.recipeCostInPaisa} is not null or ${hasRecipeNowSubquery}
          then ${orderItems.menuItemId} end)
      `,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .where(
      and(
        eq(orders.restaurantId, restaurantId),
        eq(orders.status, "completed"),
        gte(orders.placedAt, dayStart),
        lt(orders.placedAt, dayAfterEnd),
        ...(branchId ? [eq(orders.branchId, branchId)] : []),
        // RC audit P1 fix — excludes order_items belonging to a FULLY
        // refunded order (net payments <= 0 AND at least one refund
        // recorded — see the payments-vs-revenue comment on
        // getSalesSummary above for why net-paid, not orders.status,
        // is the signal). Deliberately requires an actual refund row,
        // not just "net paid <= 0" on its own — an order that was
        // completed but never paid (net paid = 0, no refund) is a real
        // sale with real recipe cost, not a reversed one, and must still
        // count. Partial refunds are NOT excluded here: there is no
        // line-item link between a refund and specific order_items, so
        // there's no correct way to reduce COGS proportionally — this is
        // an honest, documented limitation, not silently glossed over.
        excludeFullyRefundedOrders(),
      ),
    );

  return {
    cogsInPaisa: Number(row?.cogsInPaisa ?? 0),
    soldItemCount: Number(row?.soldItemCount ?? 0),
    itemsWithRecipeCount: Number(row?.itemsWithRecipeCount ?? 0),
  };
}

export type ProductProfitabilityRow = {
  name: string;
  quantitySold: number;
  revenueInPaisa: number;
  cogsInPaisa: number;
  grossProfitInPaisa: number;
  /** Null when revenueInPaisa is 0 — an undefined percentage, not a
   *  misleading 0% or "-Infinity%". */
  marginPercent: number | null;
  /** Same coverage-honesty signal as CogsSummary.itemsWithRecipeCount,
   *  but per row here: false means this item's cogsInPaisa (and therefore
   *  grossProfitInPaisa/marginPercent) is a partial/unknown-cost figure —
   *  no recipe was ever defined for at least one unit sold in this range. */
  hasFullCostCoverage: boolean;
};

/**
 * Commercial-launch Phase A.4 — Product-Level Profitability: per menu item
 * (grouped by name snapshot, same historical-stability convention
 * getTopMenuItems already uses — a rename/deletion after the sale doesn't
 * rewrite which name a past order's revenue is attributed to), how much it
 * sold for, what it cost (same snapshot-preferred/live-fallback formula as
 * getCogsSummary — see that function's own comment), and the resulting
 * gross profit / margin %. Ordered by revenue desc by default; the
 * dashboard table itself supports re-sorting by any column, so this
 * doesn't need a `sortBy` parameter — every field the UI could sort by is
 * already present in each row.
 *
 * Same fully-refunded-order exclusion as getCogsSummary (via
 * excludeFullyRefundedOrders) — applied here to BOTH revenue and cogs, so
 * a reversed sale never appears as if it still generated (or cost)
 * anything.
 */
export async function getProductProfitability(
  restaurantId: string,
  range: ReportDateRange,
  timezone: string,
  branchId?: string,
  dbOrTx: Database | Transaction = db,
): Promise<ProductProfitabilityRow[]> {
  const { dayStart, dayAfterEnd } = dayBounds(range, timezone);

  const liveRecipeCostSubquery = sql`(
    SELECT round(sum(${orderItems.quantity} * ${recipeItems.quantityPerServingMilliunits} * ${inventoryItems.costPerUnitInPaisa}) / 1000.0)
    FROM ${recipeItems}
    INNER JOIN ${inventoryItems} ON ${inventoryItems.id} = ${recipeItems.inventoryItemId}
    WHERE ${recipeItems.menuItemId} = ${orderItems.menuItemId}
  )`;
  const hasRecipeNowSubquery = sql`EXISTS (SELECT 1 FROM ${recipeItems} WHERE ${recipeItems.menuItemId} = ${orderItems.menuItemId})`;

  const rows = await dbOrTx
    .select({
      name: orderItems.menuItemNameSnapshot,
      quantitySold: sql<string>`sum(${orderItems.quantity})`,
      revenueInPaisa: sql<string>`sum(${orderItems.lineTotalInPaisa})`,
      cogsInPaisa: sql<string>`coalesce(sum(coalesce(${orderItems.recipeCostInPaisa}, ${liveRecipeCostSubquery}, 0)), 0)`,
      hasFullCostCoverage: sql<boolean>`bool_and(${orderItems.recipeCostInPaisa} is not null or ${hasRecipeNowSubquery})`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .where(
      and(
        eq(orders.restaurantId, restaurantId),
        eq(orders.status, "completed"),
        gte(orders.placedAt, dayStart),
        lt(orders.placedAt, dayAfterEnd),
        ...(branchId ? [eq(orders.branchId, branchId)] : []),
        excludeFullyRefundedOrders(),
      ),
    )
    .groupBy(orderItems.menuItemNameSnapshot)
    .orderBy(desc(sql`sum(${orderItems.lineTotalInPaisa})`));

  return rows.map((r) => {
    const revenueInPaisa = Number(r.revenueInPaisa);
    const cogsInPaisa = Number(r.cogsInPaisa);
    const grossProfitInPaisa = revenueInPaisa - cogsInPaisa;
    return {
      name: r.name,
      quantitySold: Number(r.quantitySold),
      revenueInPaisa,
      cogsInPaisa,
      grossProfitInPaisa,
      marginPercent: revenueInPaisa > 0 ? Math.round((grossProfitInPaisa / revenueInPaisa) * 10000) / 100 : null,
      hasFullCostCoverage: r.hasFullCostCoverage,
    };
  });
}

export type WastageSummary = {
  /** Ingredient cost of everything logged as "waste" in the range, valued
   *  at each item's own costPerUnitInPaisa (same weighted-average cost
   *  basis getCogsSummary uses) — "how much did spoilage/breakage/etc.
   *  actually cost us," not just a raw quantity count, which wouldn't be
   *  comparable across different units (kg vs. liters vs. pieces). */
  wastageCostInPaisa: number;
  movementCount: number;
  byReason: { reason: WasteReasonValue; costInPaisa: number; movementCount: number }[];
};

/**
 * P2 — cost/volume of wastage in the range, from stock_movements rows of
 * type "waste" (see wasteReasonEnum's schema comment). Closes the gap the
 * P2 audit flagged: wastage was recordable (dedicated movement type +
 * reason taxonomy) but had no report surfacing it. Grouped by wasteReason
 * so "60% of this month's waste was spoilage" is answerable, same
 * motivation as expense-category breakdown above.
 *
 * Deliberately its own figure, not folded into cogsInPaisa/netProfitInPaisa
 * — waste is stock that left without generating any revenue (the opposite
 * of a sale_deduction), so mixing it into "cost of GOODS SOLD" would
 * mislabel it. An owner sees it as a clearly separate cost signal instead.
 *
 * Phase A.5 — prefers stock_movements.totalCostInPaisaSnapshot, the frozen
 * cost recordStockMovement wrote at the moment this waste actually
 * happened, over inventoryItems' CURRENT costPerUnitInPaisa — same
 * snapshot-preferred/live-fallback shape as getCogsSummary (see that
 * function's own comment for why re-deriving cost from today's rate would
 * misstate history). Falls back to the live join only for rows that
 * predate this column.
 */
export async function getWastageSummary(
  restaurantId: string,
  range: ReportDateRange,
  timezone: string,
  branchId?: string,
  dbOrTx: Database | Transaction = db,
): Promise<WastageSummary> {
  const { dayStart, dayAfterEnd } = dayBounds(range, timezone);

  const rows = await dbOrTx
    .select({
      wasteReason: stockMovements.wasteReason,
      costInPaisa: sql<string>`
        coalesce(sum(coalesce(
          ${stockMovements.totalCostInPaisaSnapshot},
          round(abs(${stockMovements.quantityDeltaMilliunits}) * ${inventoryItems.costPerUnitInPaisa} / 1000.0)
        )), 0)
      `,
      movementCount: sql<string>`count(*)`,
    })
    .from(stockMovements)
    .innerJoin(inventoryItems, eq(inventoryItems.id, stockMovements.inventoryItemId))
    .where(
      and(
        eq(stockMovements.restaurantId, restaurantId),
        eq(stockMovements.type, "waste"),
        gte(stockMovements.createdAt, dayStart),
        lt(stockMovements.createdAt, dayAfterEnd),
        ...(branchId ? [eq(stockMovements.branchId, branchId)] : []),
      ),
    )
    .groupBy(stockMovements.wasteReason);

  // wasteReason is only null for non-waste movements, which this query
  // already excludes via type="waste" — recordStockMovement's own
  // validation requires a reason whenever type is "waste" (see
  // src/lib/inventory.ts), so every row here is expected to have one. The
  // filter is defensive narrowing for TypeScript, not a real branch this
  // data should ever hit.
  const byReason = rows
    .filter((r): r is typeof r & { wasteReason: WasteReasonValue } => r.wasteReason !== null)
    .map((r) => ({
      reason: r.wasteReason,
      costInPaisa: Number(r.costInPaisa),
      movementCount: Number(r.movementCount),
    }))
    .sort((a, b) => b.costInPaisa - a.costInPaisa);

  return {
    wastageCostInPaisa: byReason.reduce((sum, r) => sum + r.costInPaisa, 0),
    movementCount: byReason.reduce((sum, r) => sum + r.movementCount, 0),
    byReason,
  };
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

export async function getReportSummary(
  restaurantId: string,
  range: ReportDateRange,
  timezone: string,
  branchId?: string,
  // QA hardening pass — passed through to every sub-query below. Daily
  // Closing (see daily-closing.ts's getDailyClosingPreview) is the only
  // caller that passes an actual `tx`, so its entire snapshot — sales,
  // expenses, COGS, wastage, everything — is read from the SAME
  // transactionally-isolated connection as the eventual `daily_closes`
  // insert, instead of racing several independent connections against
  // whatever else is mutating the database concurrently. Every other
  // caller (Reports dashboard, AI assistant, dashboard-summary) omits this
  // argument entirely and keeps using the module-level `db`, unchanged.
  dbOrTx: Database | Transaction = db,
) {
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
    cogs,
    wastage,
    orderPerformance,
  ] = await Promise.all([
    getSalesSummary(restaurantId, range, timezone, branchId, dbOrTx),
    getTotalExpensesInPaisa(restaurantId, range, timezone, branchId, dbOrTx),
    getDailyRevenueVsExpenses(restaurantId, range, timezone, branchId, dbOrTx),
    getTopMenuItems(restaurantId, range, timezone, 10, branchId, dbOrTx),
    getPaymentMethodBreakdown(restaurantId, range, timezone, branchId, dbOrTx),
    getExpenseCategoryBreakdown(restaurantId, range, timezone, branchId, dbOrTx),
    getTipsSummary(restaurantId, range, timezone, branchId, dbOrTx),
    getPeakHourStats(restaurantId, range, timezone, branchId, dbOrTx),
    getCompletionStats(restaurantId, range, timezone, branchId, dbOrTx),
    getHourlyHeatmap(restaurantId, range, timezone, branchId, dbOrTx),
    // A branch-vs-branch comparison is meaningless once the whole report
    // is already scoped to one branch — skip the query entirely rather
    // than compute a comparison table that would just get discarded (the
    // UI already hides this section once it has 1 or fewer rows).
    branchId
      ? Promise.resolve([] as BranchComparisonRow[])
      : getBranchComparison(restaurantId, range, timezone, dbOrTx),
    getCogsSummary(restaurantId, range, timezone, branchId, dbOrTx),
    getWastageSummary(restaurantId, range, timezone, branchId, dbOrTx),
    getOrderPerformanceStats(restaurantId, range, timezone, branchId, dbOrTx),
  ]);

  const netProfitInPaisa = computeNetProfitInPaisa(sales.revenueInPaisa, totalExpensesInPaisa);
  // P2 — gross profit, deliberately separate from netProfitInPaisa above.
  // See getCogsSummary's own doc comment for why these two numbers are
  // allowed to disagree (same "allowed to disagree" precedent as Account
  // Books vs. Reports' revenue figure).
  const grossProfitInPaisa = sales.revenueInPaisa - cogs.cogsInPaisa;
  const grossMarginPercent =
    sales.revenueInPaisa > 0 ? Math.round((grossProfitInPaisa / sales.revenueInPaisa) * 10_000) / 100 : null;

  // Phase 16b — "vs previous period" deltas for the KPI tiles, requested
  // directly by the user (the reference dashboard they sent shows a "+8.43%
  // vs last month" pill on its Orders tile). Fetched as a second round trip
  // rather than folded into the Promise.all above so the previous period's
  // getSalesSummary/getTotalExpensesInPaisa calls can run in parallel with
  // each other without complicating the primary batch above. Still routed
  // through the same dbOrTx — when called from inside Daily Closing's
  // transaction, this comparison read is just as much a part of that one
  // consistent snapshot as everything else above.
  const previousRange = previousPeriodRange(range);
  const [previousSales, previousExpensesInPaisa] = await Promise.all([
    getSalesSummary(restaurantId, previousRange, timezone, branchId, dbOrTx),
    getTotalExpensesInPaisa(restaurantId, previousRange, timezone, branchId, dbOrTx),
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
    branchId: branchId ?? null,
    sales,
    totalExpensesInPaisa,
    netProfitInPaisa,
    cogsInPaisa: cogs.cogsInPaisa,
    grossProfitInPaisa,
    grossMarginPercent,
    cogsCoverage: {
      soldItemCount: cogs.soldItemCount,
      itemsWithRecipeCount: cogs.itemsWithRecipeCount,
    },
    wastageCostInPaisa: wastage.wastageCostInPaisa,
    wastageMovementCount: wastage.movementCount,
    wastageByReason: wastage.byReason,
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
    orderPerformance,
  };
}
