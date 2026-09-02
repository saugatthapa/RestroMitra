import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { listPurchasesForExport } from "@/lib/inventory";
import { formatQuantity } from "@/lib/quantity";
import { paisaToRupees } from "@/lib/money";
import { toCsv } from "@/lib/csv";

const EXPORT_ROW_LIMIT = 20_000;

/**
 * Commercial completion pass — Data Export gap (purchases). Gated on
 * MANAGE_INVENTORY, same as GET /purchases itself — see listPurchasesForExport
 * in src/lib/inventory.ts for why the row query lives there rather than
 * inline here (it's the same query GET /purchases already runs, just at a
 * higher row limit).
 */
export async function GET(_request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId, branchId: grantedBranchId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_INVENTORY,
    );

    const rows = await listPurchasesForExport(restaurantId, grantedBranchId, EXPORT_ROW_LIMIT);

    const csv = toCsv(rows, [
      { header: "Date", value: (r) => r.createdAt.toISOString() },
      { header: "Branch", value: (r) => r.branch?.name ?? "" },
      { header: "Supplier", value: (r) => r.supplier?.name ?? "" },
      { header: "Invoice number", value: (r) => r.invoiceNumber ?? "" },
      {
        header: "Items",
        value: (r) =>
          r.items
            .map((i) => `${i.inventoryItem.name} (${formatQuantity(i.quantityMilliunits, i.inventoryItem.unit)})`)
            .join("; "),
      },
      { header: "Total (Rs)", value: (r) => paisaToRupees(r.totalInPaisa) },
      { header: "Credit purchase", value: (r) => r.isCredit },
      { header: "Due status", value: (r) => r.ledgerEntry?.dueStatus ?? "" },
      {
        header: "Outstanding (Rs)",
        value: (r) =>
          !r.isVoided && r.ledgerEntry
            ? paisaToRupees(r.ledgerEntry.amountInPaisa - r.ledgerEntry.settledAmountInPaisa)
            : "",
      },
      { header: "Notes", value: (r) => r.notes ?? "" },
      { header: "Voided", value: (r) => r.isVoided },
    ]);

    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="purchases.csv"`,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
