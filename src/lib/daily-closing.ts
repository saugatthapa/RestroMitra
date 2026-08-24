import "server-only";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { db, type Transaction } from "@/db";
import {
  dailyCloses,
  purchases,
  expenses,
  stockMovements,
  inventoryItems,
  registerShifts,
} from "@/db/schema";
import { restaurantStartOfDay } from "@/lib/restaurant-date";
import { getReportSummary, type ReportDateRange } from "@/lib/reports";
import { HttpError } from "@/lib/http-error";

export class DailyClosingError extends HttpError {
  constructor(message: string, status = 400) {
    super(message, status);
  }
}

/** Same half-open-day convention as reports.ts's own (private) dayBounds. */
function dayBounds(businessDate: string, timezone: string) {
  const dayStart = restaurantStartOfDay(timezone, businessDate);
  const dayAfterEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  return { dayStart, dayAfterEnd };
}

/**
 * Purchases recorded this business day — genuinely new (no existing report
 * function sums the `purchases` table; getTotalExpensesInPaisa only sums
 * `expenses`, a separate table). Scoped by purchases.createdAt, the only
 * timestamp that table has (no separate "purchase date" column, same
 * limitation the rest of the app currently has for this table).
 */
export async function getPurchasesSummary(
  restaurantId: string,
  businessDate: string,
  timezone: string,
  branchId: string,
) {
  const { dayStart, dayAfterEnd } = dayBounds(businessDate, timezone);
  const [row] = await db
    .select({
      totalInPaisa: sql<string>`coalesce(sum(${purchases.totalInPaisa}), 0)`,
      purchaseCount: sql<string>`count(*)`,
    })
    .from(purchases)
    .where(
      and(
        eq(purchases.restaurantId, restaurantId),
        eq(purchases.branchId, branchId),
        gte(purchases.createdAt, dayStart),
        lt(purchases.createdAt, dayAfterEnd),
      ),
    );
  return {
    totalInPaisa: Number(row?.totalInPaisa ?? 0),
    purchaseCount: Number(row?.purchaseCount ?? 0),
  };
}

/**
 * Cash-specifically-paid expenses this business day — the "Cash expenses"
 * line the Daily Closing screen needs distinct from "Operating expenses"
 * (all methods). Same filter shape as cash-register.ts's own cash-expense
 * query, just calendar-day-scoped instead of shift-window-scoped.
 */
export async function getCashExpensesSummary(
  restaurantId: string,
  businessDate: string,
  timezone: string,
  branchId: string,
) {
  const { dayStart, dayAfterEnd } = dayBounds(businessDate, timezone);
  const [row] = await db
    .select({ totalInPaisa: sql<string>`coalesce(sum(${expenses.amountInPaisa}), 0)` })
    .from(expenses)
    .where(
      and(
        eq(expenses.branchId, branchId),
        eq(expenses.restaurantId, restaurantId),
        eq(expenses.paymentMethod, "cash"),
        eq(expenses.status, "paid"),
        eq(expenses.isVoided, false),
        gte(expenses.paidAt, dayStart),
        lt(expenses.paidAt, dayAfterEnd),
      ),
    );
  return { totalInPaisa: Number(row?.totalInPaisa ?? 0) };
}

/**
 * Manual stock adjustments (type='adjustment', NOT 'waste' — wastage has
 * its own dedicated getWastageSummary in reports.ts, reused as-is, not
 * duplicated here) this business day. Unlike waste, an adjustment can be
 * positive (found extra stock) or negative (a count correction downward),
 * so this reports a net inventory VALUE change, not a "cost" — a positive
 * number means stock value was adjusted up, negative means down.
 */
export async function getStockAdjustmentsSummary(
  restaurantId: string,
  businessDate: string,
  timezone: string,
  branchId: string,
) {
  const { dayStart, dayAfterEnd } = dayBounds(businessDate, timezone);
  const [row] = await db
    .select({
      netValueChangeInPaisa: sql<string>`
        coalesce(sum(round(${stockMovements.quantityDeltaMilliunits} * ${inventoryItems.costPerUnitInPaisa} / 1000.0)), 0)
      `,
      movementCount: sql<string>`count(*)`,
    })
    .from(stockMovements)
    .innerJoin(inventoryItems, eq(inventoryItems.id, stockMovements.inventoryItemId))
    .where(
      and(
        eq(stockMovements.restaurantId, restaurantId),
        eq(stockMovements.branchId, branchId),
        eq(stockMovements.type, "adjustment"),
        gte(stockMovements.createdAt, dayStart),
        lt(stockMovements.createdAt, dayAfterEnd),
      ),
    );
  return {
    netValueChangeInPaisa: Number(row?.netValueChangeInPaisa ?? 0),
    movementCount: Number(row?.movementCount ?? 0),
  };
}

/**
 * Aggregates every register shift CLOSED at this branch on this business
 * day. `shiftsClosedCount === 0` means "nothing to reconcile" — the
 * caller must show that honestly (spec section 9: never fabricate a
 * value that can't be calculated), not a fake zero variance implying a
 * register was actually reconciled.
 */
export async function getRegisterSummaryForDay(
  restaurantId: string,
  businessDate: string,
  timezone: string,
  branchId: string,
) {
  const { dayStart, dayAfterEnd } = dayBounds(businessDate, timezone);
  const [row] = await db
    .select({
      shiftsClosedCount: sql<string>`count(*)`,
      openingCashInPaisa: sql<string>`coalesce(sum(${registerShifts.openingCashInPaisa}), 0)`,
      expectedCashInPaisa: sql<string>`coalesce(sum(${registerShifts.expectedCashInPaisa}), 0)`,
      actualCashInPaisa: sql<string>`coalesce(sum(${registerShifts.actualCashInPaisa}), 0)`,
      varianceInPaisa: sql<string>`coalesce(sum(${registerShifts.varianceInPaisa}), 0)`,
    })
    .from(registerShifts)
    .where(
      and(
        eq(registerShifts.restaurantId, restaurantId),
        eq(registerShifts.branchId, branchId),
        eq(registerShifts.status, "closed"),
        gte(registerShifts.closedAt, dayStart),
        lt(registerShifts.closedAt, dayAfterEnd),
      ),
    );

  const shiftsClosedCount = Number(row?.shiftsClosedCount ?? 0);
  if (shiftsClosedCount === 0) {
    return {
      shiftsClosedCount: 0,
      openingCashInPaisa: null,
      expectedCashInPaisa: null,
      actualCashInPaisa: null,
      varianceInPaisa: null,
    };
  }
  return {
    shiftsClosedCount,
    openingCashInPaisa: Number(row!.openingCashInPaisa),
    expectedCashInPaisa: Number(row!.expectedCashInPaisa),
    actualCashInPaisa: Number(row!.actualCashInPaisa),
    varianceInPaisa: Number(row!.varianceInPaisa),
  };
}

export type DailyClosingSnapshot = Awaited<ReturnType<typeof getDailyClosingPreview>>;

/**
 * Assembles the full Daily Closing screen for one (branch, business day) —
 * every section the spec asks for (sales, payment methods, expenses,
 * register, inventory, profit), built from a mix of the ALREADY-EXISTING
 * getReportSummary (sales/discounts/service charge/tips/refunds/payment
 * breakdown/COGS/gross profit/net profit/wastage — nothing here is
 * recomputed) plus the genuinely new pieces above (purchases, cash
 * expenses, stock adjustments, register reconciliation) that no existing
 * report function covered. This is a live, uncommitted PREVIEW — nothing
 * is written until closeDailyBusiness() is called with this same data.
 */
export async function getDailyClosingPreview(
  restaurantId: string,
  branchId: string,
  businessDate: string,
  timezone: string,
) {
  const range: ReportDateRange = { from: businessDate, to: businessDate };
  const [report, purchasesSummary, cashExpenses, stockAdjustments, register] = await Promise.all([
    getReportSummary(restaurantId, range, timezone, branchId),
    getPurchasesSummary(restaurantId, businessDate, timezone, branchId),
    getCashExpensesSummary(restaurantId, businessDate, timezone, branchId),
    getStockAdjustmentsSummary(restaurantId, businessDate, timezone, branchId),
    getRegisterSummaryForDay(restaurantId, businessDate, timezone, branchId),
  ]);

  return {
    businessDate,
    branchId,
    sales: {
      // Reconstructed pre-discount, pre-refund total — a straightforward
      // sum of numbers already returned by getSalesSummary, not a new
      // definition invented here.
      grossSalesInPaisa: report.sales.revenueInPaisa + report.sales.discountInPaisa + report.sales.refundInPaisa,
      discountInPaisa: report.sales.discountInPaisa,
      serviceChargeInPaisa: report.sales.serviceChargeInPaisa,
      tipsInPaisa: report.totalTipsInPaisa,
      netSalesInPaisa: report.sales.revenueInPaisa,
      refundInPaisa: report.sales.refundInPaisa,
      orderCount: report.sales.orderCount,
    },
    paymentBreakdown: report.paymentBreakdown,
    expenses: {
      operatingExpensesInPaisa: report.totalExpensesInPaisa,
      cashExpensesInPaisa: cashExpenses.totalInPaisa,
      purchasesInPaisa: purchasesSummary.totalInPaisa,
      purchaseCount: purchasesSummary.purchaseCount,
    },
    register,
    inventory: {
      purchasesInPaisa: purchasesSummary.totalInPaisa,
      wastageCostInPaisa: report.wastageCostInPaisa,
      stockAdjustmentNetValueChangeInPaisa: stockAdjustments.netValueChangeInPaisa,
      stockAdjustmentMovementCount: stockAdjustments.movementCount,
    },
    profit: {
      revenueInPaisa: report.sales.revenueInPaisa,
      cogsInPaisa: report.cogsInPaisa,
      grossProfitInPaisa: report.grossProfitInPaisa,
      operatingExpensesInPaisa: report.totalExpensesInPaisa,
      netProfitInPaisa: report.netProfitInPaisa,
    },
  };
}

/** True if `businessDate` has already been closed at this branch — the lock check. */
export async function isBusinessDateClosed(
  restaurantId: string,
  branchId: string,
  businessDate: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: dailyCloses.id })
    .from(dailyCloses)
    .where(
      and(
        eq(dailyCloses.restaurantId, restaurantId),
        eq(dailyCloses.branchId, branchId),
        eq(dailyCloses.businessDate, businessDate),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Closes a business day: computes the preview one final time (inside the
 * same transaction, so nothing can change between preview and commit) and
 * freezes it into a new `daily_closes` row. The unique index on
 * (restaurantId, branchId, businessDate) is the actual concurrency
 * guarantee — a duplicate close attempt gets a clear 409, not a silent
 * second row or a raw DB error.
 */
export async function closeDailyBusiness(
  tx: Transaction,
  params: {
    restaurantId: string;
    branchId: string;
    businessDate: string;
    timezone: string;
    closedByUserId: string;
    notes?: string | null;
  },
) {
  const snapshot = await getDailyClosingPreview(
    params.restaurantId,
    params.branchId,
    params.businessDate,
    params.timezone,
  );

  try {
    const [row] = await tx
      .insert(dailyCloses)
      .values({
        restaurantId: params.restaurantId,
        branchId: params.branchId,
        businessDate: params.businessDate,
        closedByUserId: params.closedByUserId,
        revenueInPaisa: snapshot.profit.revenueInPaisa,
        cogsInPaisa: snapshot.profit.cogsInPaisa,
        netProfitInPaisa: snapshot.profit.netProfitInPaisa,
        cashVarianceInPaisa: snapshot.register.varianceInPaisa,
        notes: params.notes ?? null,
        snapshotJson: snapshot,
      })
      .returning();
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new DailyClosingError(
        `${params.businessDate} has already been closed for this branch.`,
        409,
      );
    }
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  const code =
    (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
  return code === "23505";
}
