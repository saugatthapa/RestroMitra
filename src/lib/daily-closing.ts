import "server-only";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { db, type Database, type Transaction } from "@/db";
import { isUniqueViolation } from "@/lib/db-error";
import {
  dailyCloses,
  purchases,
  expenses,
  stockMovements,
  inventoryItems,
  registerShifts,
} from "@/db/schema";
import { restaurantDate, restaurantStartOfDay } from "@/lib/restaurant-date";
import { getReportSummary, type ReportDateRange } from "@/lib/reports";
import { HttpError } from "@/lib/http-error";
import { requirePermission } from "@/lib/rbac/guard";
import { PERMISSIONS } from "@/lib/rbac/permissions";

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
  // QA hardening pass — see reports.ts's getSalesSummary for the full
  // rationale: this optional trailing param lets closeDailyBusiness route
  // every summary function through its OWN open transaction, so the frozen
  // daily_closes snapshot is computed from one consistent view of the
  // database instead of several independent, non-isolated connections.
  // Every other existing caller (the preview route, tests) omits it and
  // keeps using the module-level `db`, unchanged.
  dbOrTx: Database | Transaction = db,
) {
  const { dayStart, dayAfterEnd } = dayBounds(businessDate, timezone);
  const [row] = await dbOrTx
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
  dbOrTx: Database | Transaction = db,
) {
  const { dayStart, dayAfterEnd } = dayBounds(businessDate, timezone);
  const [row] = await dbOrTx
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
  dbOrTx: Database | Transaction = db,
) {
  const { dayStart, dayAfterEnd } = dayBounds(businessDate, timezone);
  const [row] = await dbOrTx
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
  dbOrTx: Database | Transaction = db,
) {
  const { dayStart, dayAfterEnd } = dayBounds(businessDate, timezone);
  const [row] = await dbOrTx
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
  // QA hardening pass — threaded through to every sub-summary below (see
  // getPurchasesSummary's comment). closeDailyBusiness passes its own
  // `tx` here so the ENTIRE preview — sales, COGS, wastage, purchases,
  // cash expenses, stock adjustments, register reconciliation — is
  // computed from one transactionally-consistent snapshot immediately
  // before the freezing insert, rather than several independent
  // connections that could each observe a different, partially-mutated
  // state of the database. The read-only preview route still omits this
  // and reads from the plain module-level `db`, which is correct there —
  // that route never writes anything, so there is no transaction to be
  // consistent WITH.
  dbOrTx: Database | Transaction = db,
) {
  const range: ReportDateRange = { from: businessDate, to: businessDate };
  const [report, purchasesSummary, cashExpenses, stockAdjustments, register] = await Promise.all([
    getReportSummary(restaurantId, range, timezone, branchId, dbOrTx),
    getPurchasesSummary(restaurantId, businessDate, timezone, branchId, dbOrTx),
    getCashExpensesSummary(restaurantId, businessDate, timezone, branchId, dbOrTx),
    getStockAdjustmentsSummary(restaurantId, businessDate, timezone, branchId, dbOrTx),
    getRegisterSummaryForDay(restaurantId, businessDate, timezone, branchId, dbOrTx),
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
  // QA hardening pass — same optional-trailing-param convention as the
  // rest of this module. A mutation route that wants to check-and-write
  // atomically (no gap between the lock check and the write it's guarding)
  // should pass its own open `tx` here so both happen against the same
  // snapshot; the two pre-existing callers (refunds route, preview route)
  // keep reading through the plain module-level `db`, unchanged.
  dbOrTx: Database | Transaction = db,
): Promise<boolean> {
  const rows = await dbOrTx
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
 * QA hardening pass (Phase 5 / master prompt section 7) — the centralized
 * daily-close lock. Before this, `isBusinessDateClosed` existed but had
 * only ever been wired into ONE mutation route (refunds) — every other
 * financial mutation (payments, expenses, purchases, inventory
 * adjustments, wastage, stock counts, payroll payments, cash register
 * shifts/movements, ...) could freely write against a business day that
 * had already been closed and frozen into a `daily_closes` snapshot,
 * silently making that snapshot wrong from the moment of the write —
 * exactly the gap this helper closes by becoming the ONE place every such
 * mutation route calls, instead of leaving it to each route author to
 * remember to duplicate the refunds route's own inline check.
 *
 * Policy — same as the refunds route already established (Commercial
 * Launch Phase A.2, spec section 10), now applied uniformly: closing a
 * business day does NOT freeze the underlying ledger shut. It raises the
 * trust bar. While the day is open, whatever permission a mutation route
 * already requires (EDIT_ORDER, MANAGE_EXPENSES, MANAGE_INVENTORY, ...) is
 * sufficient. Once the day is closed, the caller must ALSO hold
 * MANAGE_DAILY_CLOSING (manager/accountant/owner in the default role
 * matrix) — an ordinary waiter/cashier/kitchen-staff grant is no longer
 * enough. This is deliberate, not a compromise: a hard block would mean a
 * genuine late correction (a missed expense entered the next morning, a
 * supplier payment posted a day late) has no path forward at all short of
 * reopening the close, which this app doesn't support. Every late write is
 * still fully audited by its own route (recordAuditLog) exactly as before;
 * only the frozen `daily_closes.snapshotJson` itself is immutable (see
 * closeDailyBusiness above) — Reports/Account Books will simply disagree
 * with that frozen snapshot from the moment of a late write onward, which
 * is the same accepted, already-shipped tradeoff the refunds route lived
 * with alone until now.
 *
 * Deliberately takes a single options object rather than a long run of
 * same-typed string positional params (userId/restaurantId/branchId/
 * businessDate would be trivial to pass in the wrong order at a call
 * site) — every other guard in rbac/guard.ts got away with 2-3 positional
 * ids; this one has four, so the object form is worth the extra verbosity
 * for safety at ~10 call sites.
 *
 * `dbOrTx` — pass the caller's own open transaction so the lock check
 * participates in the same snapshot as the write it's guarding, same
 * convention as every other function in this module.
 */
export async function assertBusinessDayWritable(
  params: {
    userId: string;
    restaurantId: string;
    branchId: string;
    businessDate: string;
    /** Pass the caller's already-resolved role (from resolveRestaurantContext) to skip re-deriving it — see requirePermission's own doc comment for the same perf rationale. */
    role?: string;
  },
  dbOrTx: Database | Transaction = db,
): Promise<void> {
  const closed = await isBusinessDateClosed(
    params.restaurantId,
    params.branchId,
    params.businessDate,
    dbOrTx,
  );
  if (!closed) return;
  await requirePermission(
    params.userId,
    params.restaurantId,
    PERMISSIONS.MANAGE_DAILY_CLOSING,
    params.role,
  );
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
  // QA hardening pass (Phase 5b) — reject closing a business date that
  // hasn't happened yet in the RESTAURANT's own timezone. Enforced here,
  // in the one service-layer function every close request must go
  // through, rather than only in the request-validation schema — a
  // schema-level check can't know "today" (that depends on the
  // restaurant's timezone, resolved per-request), and centralizing the
  // check here means any future caller of closeDailyBusiness inherits it
  // for free, matching this codebase's "improve the shared helper, don't
  // duplicate the check per call site" convention. Plain string comparison
  // is safe: both sides are YYYY-MM-DD, which sorts lexicographically
  // identically to chronologically.
  const today = restaurantDate(params.timezone);
  if (params.businessDate > today) {
    throw new DailyClosingError(
      `Cannot close ${params.businessDate} — that is in the future (today is ${today} for this restaurant).`,
      400,
    );
  }

  // QA hardening pass — `tx` is now threaded all the way down through
  // getDailyClosingPreview into every summary function it calls (sales,
  // COGS, wastage, purchases, cash expenses, stock adjustments, register).
  // Previously this call omitted `tx` entirely, so the ENTIRE preview ran
  // on separate, non-transactional connections concurrently with the
  // final `tx.insert` below — a mutation landing between the preview reads
  // and the insert (e.g. a payment or expense recorded mid-close) could
  // produce a snapshot that was already stale the moment it was frozen.
  // Now every read here participates in the same transaction as the
  // insert, so the frozen snapshot is guaranteed internally consistent.
  const snapshot = await getDailyClosingPreview(
    params.restaurantId,
    params.branchId,
    params.businessDate,
    params.timezone,
    tx,
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
