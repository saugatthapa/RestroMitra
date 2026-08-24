import "server-only";
import { and, eq } from "drizzle-orm";
import { db, type Transaction } from "@/db";
import { ledgerEntries, purchaseItems, purchases, suppliers } from "@/db/schema";
import { HttpError } from "@/lib/http-error";
import { recordStockMovement } from "@/lib/inventory";
import { restaurantDate } from "@/lib/restaurant-date";

export class SupplierDuesError extends HttpError {
  constructor(message: string, status = 400) {
    super(message, status);
  }
}

export type SupplierDueStatusFilter = "all" | "overdue" | "due_today" | "due_this_week";

export type SupplierDueRow = {
  purchaseId: string;
  ledgerEntryId: string;
  supplierId: string | null;
  supplierName: string | null;
  branchId: string;
  invoiceNumber: string | null;
  totalInPaisa: number;
  settledAmountInPaisa: number;
  outstandingInPaisa: number;
  dueDate: string | null;
  createdAt: Date;
  isOverdue: boolean;
};

/**
 * Supplier Due Report (commercial-launch spec Section 11-14): every
 * unsettled credit purchase, bucketed by due date, plus a per-supplier
 * outstanding rollup.
 *
 * Reads purchases JOIN ledgerEntries (referenceType="purchase") rather
 * than tracking a second "amount paid" figure anywhere — the ledger
 * entry's dueStatus/settledAmountInPaisa is the ONE source of truth for
 * what's been paid against a purchase (see recordPurchaseLedgerEntry /
 * settleLedgerDue in ledger.ts). A fully-settled purchase's ledger entry
 * flips to dueStatus="settled" and drops out of this report on its own;
 * a voided purchase's ledger entry is separately marked isVoided (see
 * voidPurchase below), so both are excluded by the same WHERE clause
 * without extra bookkeeping.
 */
export async function getSupplierDueReport(
  restaurantId: string,
  timezone: string,
  filters: { branchId?: string; supplierId?: string; status?: SupplierDueStatusFilter } = {},
) {
  const today = restaurantDate(timezone);
  const weekAheadDate = restaurantDate(timezone, new Date(Date.now() + 7 * 86_400_000));

  const conditions = [
    eq(purchases.restaurantId, restaurantId),
    eq(purchases.isCredit, true),
    eq(purchases.isVoided, false),
    eq(ledgerEntries.dueStatus, "outstanding"),
    eq(ledgerEntries.isVoided, false),
  ];
  if (filters.branchId) conditions.push(eq(purchases.branchId, filters.branchId));
  if (filters.supplierId) conditions.push(eq(purchases.supplierId, filters.supplierId));

  const joined = await db
    .select({
      purchaseId: purchases.id,
      ledgerEntryId: ledgerEntries.id,
      supplierId: purchases.supplierId,
      supplierName: suppliers.name,
      branchId: purchases.branchId,
      invoiceNumber: purchases.invoiceNumber,
      totalInPaisa: ledgerEntries.amountInPaisa,
      settledAmountInPaisa: ledgerEntries.settledAmountInPaisa,
      dueDate: purchases.dueDate,
      createdAt: purchases.createdAt,
    })
    .from(purchases)
    .innerJoin(
      ledgerEntries,
      and(eq(ledgerEntries.referenceType, "purchase"), eq(ledgerEntries.referenceId, purchases.id)),
    )
    .leftJoin(suppliers, eq(suppliers.id, purchases.supplierId))
    .where(and(...conditions));

  // Every outstanding row, regardless of status filter — the bucket totals
  // below (overdue/due-today/due-this-week) always reflect the FULL set so
  // a caller filtering `rows` to one bucket still sees accurate totals for
  // all buckets, not just the one they're looking at.
  const allRows: SupplierDueRow[] = joined.map((r) => ({
    ...r,
    outstandingInPaisa: r.totalInPaisa - r.settledAmountInPaisa,
    isOverdue: !!r.dueDate && r.dueDate < today,
  }));

  const totalDueInPaisa = allRows.reduce((sum, r) => sum + r.outstandingInPaisa, 0);
  const overdueInPaisa = allRows.filter((r) => r.isOverdue).reduce((sum, r) => sum + r.outstandingInPaisa, 0);
  const dueTodayInPaisa = allRows
    .filter((r) => r.dueDate === today)
    .reduce((sum, r) => sum + r.outstandingInPaisa, 0);
  // Deliberately mutually exclusive with both overdue and due-today — "due
  // this week" means "due in the next 7 days, but not today and not
  // already overdue" (dueDate strictly after today), so the four bucket
  // totals never double-count the same purchase and can be shown side by
  // side without the numbers implying more total risk than actually
  // exists.
  const dueThisWeekInPaisa = allRows
    .filter((r) => !r.isOverdue && !!r.dueDate && r.dueDate > today && r.dueDate <= weekAheadDate)
    .reduce((sum, r) => sum + r.outstandingInPaisa, 0);

  const bySupplier = new Map<
    string,
    {
      supplierId: string | null;
      supplierName: string;
      outstandingInPaisa: number;
      overdueInPaisa: number;
      purchaseCount: number;
    }
  >();
  for (const r of allRows) {
    const key = r.supplierId ?? "unknown";
    const existing = bySupplier.get(key) ?? {
      supplierId: r.supplierId,
      supplierName: r.supplierName ?? "Unknown supplier",
      outstandingInPaisa: 0,
      overdueInPaisa: 0,
      purchaseCount: 0,
    };
    existing.outstandingInPaisa += r.outstandingInPaisa;
    if (r.isOverdue) existing.overdueInPaisa += r.outstandingInPaisa;
    existing.purchaseCount += 1;
    bySupplier.set(key, existing);
  }

  const status = filters.status ?? "all";
  const filteredRows = allRows.filter((r) => {
    if (status === "overdue") return r.isOverdue;
    if (status === "due_today") return r.dueDate === today;
    if (status === "due_this_week") return !r.isOverdue && !!r.dueDate && r.dueDate > today && r.dueDate <= weekAheadDate;
    return true;
  });

  return {
    totalDueInPaisa,
    overdueInPaisa,
    dueTodayInPaisa,
    dueThisWeekInPaisa,
    supplierWise: Array.from(bySupplier.values()).sort((a, b) => b.outstandingInPaisa - a.outstandingInPaisa),
    rows: filteredRows.sort((a, b) => (a.dueDate ?? "9999-99-99").localeCompare(b.dueDate ?? "9999-99-99")),
  };
}

/**
 * Voids a purchase — used to correct a mistaken/duplicate/cancelled
 * delivery without simply mutating the historical record. Rejects if
 * already voided, or if any amount has been settled against its linked
 * ledger due (a recorded payment means there's real money already moved
 * against this purchase; that must be reversed/handled first, not silently
 * orphaned by a void).
 *
 * What this DOES reverse: each line item's STOCK QUANTITY (a new
 * "adjustment" stock movement, negated) and the linked ledger entry
 * (marked isVoided, dropping it out of both the account books and the
 * supplier due report).
 *
 * What this DELIBERATELY DOES NOT reverse: the item's weighted-average
 * costPerUnitInPaisa. applyPurchaseCosting's own comment explains why —
 * weighted-average costing is not generally reversible once later
 * purchases/sales have touched the same item's average. Attempting to
 * "undo" the average here would silently produce a WRONG cost basis
 * (Section 1 / Section 66 of the commercial-launch spec: never fake a
 * correction that isn't actually correct). This is a known, documented
 * limitation — an owner who voids a purchase should expect the item's
 * current cost-per-unit to still reflect that purchase's contribution to
 * the average, even though the stock quantity and the money due are both
 * cleanly reversed.
 */
export async function voidPurchase(
  tx: Transaction,
  params: {
    restaurantId: string;
    purchaseId: string;
    voidedByUserId: string;
    reason: string;
  },
) {
  const [purchase] = await tx
    .select()
    .from(purchases)
    .where(and(eq(purchases.id, params.purchaseId), eq(purchases.restaurantId, params.restaurantId)))
    .for("update")
    .limit(1);
  if (!purchase) {
    throw new SupplierDuesError("Purchase not found.", 404);
  }
  if (purchase.isVoided) {
    throw new SupplierDuesError("This purchase has already been voided.", 409);
  }

  const [ledgerEntry] = await tx
    .select()
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.restaurantId, params.restaurantId),
        eq(ledgerEntries.referenceType, "purchase"),
        eq(ledgerEntries.referenceId, purchase.id),
      ),
    )
    .for("update")
    .limit(1);

  if (ledgerEntry?.isVoided) {
    throw new SupplierDuesError("This purchase has already been voided.", 409);
  }
  if (ledgerEntry && ledgerEntry.settledAmountInPaisa > 0) {
    throw new SupplierDuesError(
      "A payment has already been recorded against this purchase, so it can no longer be voided.",
    );
  }

  const lineItems = await tx.select().from(purchaseItems).where(eq(purchaseItems.purchaseId, purchase.id));

  for (const line of lineItems) {
    await recordStockMovement(tx, {
      restaurantId: params.restaurantId,
      branchId: purchase.branchId,
      inventoryItemId: line.inventoryItemId,
      type: "adjustment",
      quantityDeltaMilliunits: -line.quantityMilliunits,
      referenceType: "purchase_void",
      referenceId: purchase.id,
      note: `Purchase voided: ${params.reason}`,
      recordedByUserId: params.voidedByUserId,
    });
  }

  if (ledgerEntry) {
    const [updatedLedgerEntry] = await tx
      .update(ledgerEntries)
      .set({ isVoided: true, updatedAt: new Date() })
      .where(and(eq(ledgerEntries.id, ledgerEntry.id), eq(ledgerEntries.isVoided, false)))
      .returning();
    if (!updatedLedgerEntry) {
      throw new SupplierDuesError(
        "This purchase was just voided by someone else. Please refresh and try again.",
        409,
      );
    }
  }

  const [updatedPurchase] = await tx
    .update(purchases)
    .set({ isVoided: true, voidedAt: new Date(), voidedByUserId: params.voidedByUserId })
    .where(and(eq(purchases.id, purchase.id), eq(purchases.isVoided, false)))
    .returning();
  if (!updatedPurchase) {
    throw new SupplierDuesError(
      "This purchase was just voided by someone else. Please refresh and try again.",
      409,
    );
  }

  return { purchase: updatedPurchase, reversedLineItemCount: lineItems.length };
}
