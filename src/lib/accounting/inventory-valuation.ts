import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { accountMappings, chartOfAccounts } from "@/db/schema";
import { MAPPING_KEYS } from "./account-mapping-keys";
import { getCashBookReport, type CashBookLine } from "./cash-book";
import type { AccountingVoucherType } from "./post-voucher";

/**
 * Phase 7, Slice 7d — Inventory Valuation. Per ACCOUNTING_PHASE_7_PLAN.md
 * Part 2.3: this codebase has no per-item inventory costing method (FIFO/
 * weighted-average) feeding the ledger — inventory QUANTITY tracking exists
 * for operations, but isn't tied to a per-unit cost basis. Rather than
 * invent a second, independent valuation method that could drift from what
 * the ledger itself already says, this report values inventory exactly the
 * way this codebase's own postings already do: the Inventory account's own
 * chart-of-accounts balance (debited on purchase, per
 * integrations/purchases.ts; credited to Cost of Goods Sold on a sale's
 * own COGS leg, per integrations/order-completion.ts) IS the accounting
 * valuation. This report exposes that balance clearly as of a date, with a
 * breakdown of what moved it in a period, rather than a second, possibly
 * disagreeing number.
 *
 * Built directly on Slice 7a's `getCashBookReport` — Inventory is just
 * another account with an opening balance, a running balance through a
 * period, and a closing balance; the only thing this module adds is
 * grouping that same line-level activity into Purchases / Cost of Goods
 * Sold / Adjustments so an owner can see WHY inventory moved, not just
 * that it did. Confirmed by inspection: only two integration points post
 * to Inventory automatically today — `purchase` vouchers (increase) and a
 * sale's own COGS leg, itself posted under voucherType `sales` (decrease;
 * the SAME sales voucher's separate revenue leg never touches Inventory at
 * all, so it never appears in a query already scoped to this one account).
 * Anything else touching Inventory (a manual journal adjustment, the
 * opening balance voucher) falls into "Adjustments."
 */

export type InventoryMovementCategory = "purchases" | "costOfGoodsSold" | "adjustments";

const CATEGORY_BY_VOUCHER_TYPE: Partial<Record<AccountingVoucherType, InventoryMovementCategory>> = {
  purchase: "purchases",
  sales: "costOfGoodsSold",
};

function categoryFor(voucherType: string): InventoryMovementCategory {
  return CATEGORY_BY_VOUCHER_TYPE[voucherType as AccountingVoucherType] ?? "adjustments";
}

export type InventoryValuationReport = {
  accountId: string;
  accountCode: string;
  accountName: string;
  fromDate: string;
  toDate: string;
  openingValuationInPaisa: number;
  closingValuationInPaisa: number;
  /** Positive — purchases increase inventory. */
  purchasesInPaisa: number;
  /** Negative (or zero) — the COGS leg of a sale decreases inventory. */
  costOfGoodsSoldInPaisa: number;
  /** Net of any other voucher type touching Inventory (manual adjustments, opening balance) — can be either sign. */
  adjustmentsInPaisa: number;
  lines: CashBookLine[];
};

async function resolveInventoryAccountId(restaurantId: string): Promise<string | null> {
  const [row] = await db
    .select({ accountId: accountMappings.accountId, isActive: chartOfAccounts.isActive })
    .from(accountMappings)
    .innerJoin(chartOfAccounts, eq(chartOfAccounts.id, accountMappings.accountId))
    .where(
      and(eq(accountMappings.restaurantId, restaurantId), eq(accountMappings.mappingKey, MAPPING_KEYS.INVENTORY)),
    )
    .limit(1);
  if (!row || !row.isActive) return null;
  return row.accountId;
}

/**
 * `null` if this restaurant has no Inventory account mapped yet (or it's
 * been deactivated) — same "viewable before accounting is fully set up"
 * convention every other Phase 5/6/7 report in this module follows, never
 * an error.
 */
export async function getInventoryValuationReport(params: {
  restaurantId: string;
  fromDate: string;
  toDate: string;
}): Promise<InventoryValuationReport | null> {
  const accountId = await resolveInventoryAccountId(params.restaurantId);
  if (!accountId) return null;

  const cashBook = await getCashBookReport({
    restaurantId: params.restaurantId,
    accountId,
    fromDate: params.fromDate,
    toDate: params.toDate,
  });
  // Shouldn't happen — accountId was just resolved for this restaurant —
  // but mirrors getCashBookReport's own null contract rather than
  // asserting non-null.
  if (!cashBook) return null;

  let purchasesInPaisa = 0;
  let costOfGoodsSoldInPaisa = 0;
  let adjustmentsInPaisa = 0;

  for (const line of cashBook.lines) {
    const netInPaisa = line.debitInPaisa - line.creditInPaisa; // Inventory is asset/debit-normal
    const category = categoryFor(line.voucherType);
    if (category === "purchases") purchasesInPaisa += netInPaisa;
    else if (category === "costOfGoodsSold") costOfGoodsSoldInPaisa += netInPaisa;
    else adjustmentsInPaisa += netInPaisa;
  }

  return {
    accountId: cashBook.account.accountId,
    accountCode: cashBook.account.code,
    accountName: cashBook.account.name,
    fromDate: params.fromDate,
    toDate: params.toDate,
    openingValuationInPaisa: cashBook.openingBalanceInPaisa,
    closingValuationInPaisa: cashBook.closingBalanceInPaisa,
    purchasesInPaisa,
    costOfGoodsSoldInPaisa,
    adjustmentsInPaisa,
    lines: cashBook.lines,
  };
}
