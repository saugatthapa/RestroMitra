import "server-only";
import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { ledgerEntries } from "@/db/schema";

export type LedgerBookGranularity = "month" | "year";

/**
 * Day-book / month-book / year-book views — Account Books, Phase 19. A
 * day-book is the raw entry list for one calendar day; month/year books
 * are rollups (one row per day, or one row per month) with a drill-down
 * anchor date the UI can re-request at the next granularity down. Every
 * query here excludes voided entries — a voided manual entry is kept for
 * audit (see the ledger list route) but never counted toward any book.
 *
 * "Realized" (credit/debitInPaisa) vs "outstanding"
 * (outstandingCredit/DebitInPaisa) totals are always split apart rather
 * than netted together — an outstanding entry represents no actual cash
 * movement yet (see the ledgerEntries table comment in schema.ts), so
 * folding it into the same "cash in/out" figure would overstate how much
 * money is actually sitting in the till.
 */

type LedgerTotals = {
  creditInPaisa: number;
  debitInPaisa: number;
  netInPaisa: number;
  outstandingCreditInPaisa: number;
  outstandingDebitInPaisa: number;
};

const ZERO_TOTALS: LedgerTotals = {
  creditInPaisa: 0,
  debitInPaisa: 0,
  netInPaisa: 0,
  outstandingCreditInPaisa: 0,
  outstandingDebitInPaisa: 0,
};

function totalsFromRow(row: {
  creditInPaisa: string;
  debitInPaisa: string;
  outstandingCreditInPaisa: string;
  outstandingDebitInPaisa: string;
}): LedgerTotals {
  const creditInPaisa = Number(row.creditInPaisa);
  const debitInPaisa = Number(row.debitInPaisa);
  return {
    creditInPaisa,
    debitInPaisa,
    netInPaisa: creditInPaisa - debitInPaisa,
    outstandingCreditInPaisa: Number(row.outstandingCreditInPaisa),
    outstandingDebitInPaisa: Number(row.outstandingDebitInPaisa),
  };
}

const TOTALS_SELECT = {
  creditInPaisa: sql<string>`coalesce(sum(case when ${ledgerEntries.direction} = 'credit' and ${ledgerEntries.dueStatus} != 'outstanding' then ${ledgerEntries.amountInPaisa} else 0 end), 0)`,
  debitInPaisa: sql<string>`coalesce(sum(case when ${ledgerEntries.direction} = 'debit' and ${ledgerEntries.dueStatus} != 'outstanding' then ${ledgerEntries.amountInPaisa} else 0 end), 0)`,
  // The REMAINING balance (amount - what's already been settled), not the
  // original amount — a partially-settled entry stays dueStatus
  // 'outstanding' until fully paid off (see settleLedgerDue), so summing
  // amountInPaisa alone would keep counting the already-collected/paid
  // portion as still outstanding forever.
  outstandingCreditInPaisa: sql<string>`coalesce(sum(case when ${ledgerEntries.direction} = 'credit' and ${ledgerEntries.dueStatus} = 'outstanding' then ${ledgerEntries.amountInPaisa} - ${ledgerEntries.settledAmountInPaisa} else 0 end), 0)`,
  outstandingDebitInPaisa: sql<string>`coalesce(sum(case when ${ledgerEntries.direction} = 'debit' and ${ledgerEntries.dueStatus} = 'outstanding' then ${ledgerEntries.amountInPaisa} - ${ledgerEntries.settledAmountInPaisa} else 0 end), 0)`,
};

/** Last calendar day of `year`-`month` (1-indexed month), as YYYY-MM-DD. */
function lastDayOfMonth(year: number, month: number): string {
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate(); // day 0 of next month
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The single day's full entry list plus its totals — the "day book". */
export async function getLedgerDayBook(restaurantId: string, date: string) {
  const [entries, [totalsRow]] = await Promise.all([
    db.query.ledgerEntries.findMany({
      where: (e, { and: dAnd, eq: dEq }) =>
        dAnd(dEq(e.restaurantId, restaurantId), dEq(e.entryDate, date), dEq(e.isVoided, false)),
      orderBy: (e, { asc: dAsc }) => [dAsc(e.createdAt)],
    }),
    db
      .select(TOTALS_SELECT)
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.restaurantId, restaurantId),
          eq(ledgerEntries.entryDate, date),
          eq(ledgerEntries.isVoided, false),
        ),
      ),
  ]);

  return {
    date,
    entries,
    totals: totalsRow ? totalsFromRow(totalsRow) : ZERO_TOTALS,
  };
}

// key is "YYYY-MM-DD" for a month-book row (one row per day) or "YYYY-MM"
// for a year-book row (one row per month) — the UI formats it for display
// and reuses it verbatim as the anchorDate for a drill-down request.
export type LedgerRollupRow = { key: string } & LedgerTotals;

/**
 * Month book (one row per day) or year book (one row per month) — a
 * rollup grid, not individual entries; the UI drills into a specific
 * day's getLedgerDayBook from a month-book row, or a specific month's
 * this-same-function-at-"month"-granularity from a year-book row.
 */
export async function getLedgerRollup(
  restaurantId: string,
  granularity: LedgerBookGranularity,
  anchorDate: string,
) {
  const [year, month] = anchorDate.split("-").map(Number);
  const from = granularity === "month" ? `${year}-${String(month).padStart(2, "0")}-01` : `${year}-01-01`;
  const to = granularity === "month" ? lastDayOfMonth(year, month) : `${year}-12-31`;
  const bucketExpr =
    granularity === "month"
      ? sql<string>`to_char(${ledgerEntries.entryDate}, 'YYYY-MM-DD')`
      : sql<string>`to_char(${ledgerEntries.entryDate}, 'YYYY-MM')`;

  const [rows, [totalsRow]] = await Promise.all([
    db
      .select({ bucket: bucketExpr, ...TOTALS_SELECT })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.restaurantId, restaurantId),
          eq(ledgerEntries.isVoided, false),
          gte(ledgerEntries.entryDate, from),
          lte(ledgerEntries.entryDate, to),
        ),
      )
      .groupBy(bucketExpr)
      .orderBy(asc(bucketExpr)),
    db
      .select(TOTALS_SELECT)
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.restaurantId, restaurantId),
          eq(ledgerEntries.isVoided, false),
          gte(ledgerEntries.entryDate, from),
          lte(ledgerEntries.entryDate, to),
        ),
      ),
  ]);

  return {
    granularity,
    from,
    to,
    rows: rows.map((row) => ({
      key: row.bucket,
      ...totalsFromRow(row),
    })) satisfies LedgerRollupRow[],
    totals: totalsRow ? totalsFromRow(totalsRow) : ZERO_TOTALS,
  };
}

/**
 * Every currently-outstanding due, oldest first — the "who owes whom"
 * view, deliberately NOT date-scoped (a due from three months ago is
 * still exactly as outstanding today). `remainingInPaisa` accounts for
 * partial settlement via settleLedgerDue.
 */
export async function getOutstandingDues(restaurantId: string) {
  const rows = await db.query.ledgerEntries.findMany({
    where: (e, { and: dAnd, eq: dEq }) =>
      dAnd(dEq(e.restaurantId, restaurantId), dEq(e.dueStatus, "outstanding"), dEq(e.isVoided, false)),
    orderBy: (e, { asc: dAsc }) => [dAsc(e.entryDate), dAsc(e.createdAt)],
  });

  return rows.map((entry) => ({
    ...entry,
    remainingInPaisa: entry.amountInPaisa - entry.settledAmountInPaisa,
  }));
}
