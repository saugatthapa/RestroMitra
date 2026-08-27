import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { inventoryItems, suppliers } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { isLowStock } from "@/lib/inventory";
import { formatQuantity, milliunitsToUnits } from "@/lib/quantity";
import { paisaToRupees } from "@/lib/money";
import { toCsv } from "@/lib/csv";

const EXPORT_ROW_LIMIT = 20_000;

/**
 * Commercial completion pass — Data Export gap. Same "reuse the read
 * permission, no new EXPORT_DATA permission" principle as the existing
 * ledger/reconciliation exports (see that route's doc comment) — gated on
 * MANAGE_INVENTORY, same as GET /inventory-items itself.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_INVENTORY);

    const rows = await db
      .select({ item: inventoryItems, supplierName: suppliers.name })
      .from(inventoryItems)
      .leftJoin(suppliers, eq(inventoryItems.preferredSupplierId, suppliers.id))
      .where(eq(inventoryItems.restaurantId, restaurantId))
      .orderBy(asc(inventoryItems.name))
      .limit(EXPORT_ROW_LIMIT);

    const csv = toCsv(rows, [
      { header: "Name", value: (r) => r.item.name },
      { header: "Unit", value: (r) => r.item.unit },
      { header: "Current stock", value: (r) => formatQuantity(r.item.currentStockMilliunits, r.item.unit) },
      {
        header: "Reorder level",
        value: (r) =>
          r.item.reorderLevelMilliunits === null
            ? ""
            : milliunitsToUnits(r.item.reorderLevelMilliunits),
      },
      { header: "Low stock", value: (r) => isLowStock(r.item) },
      { header: "Cost per unit (Rs)", value: (r) => paisaToRupees(r.item.costPerUnitInPaisa) },
      { header: "Preferred supplier", value: (r) => r.supplierName ?? "" },
      { header: "Active", value: (r) => r.item.isActive },
    ]);

    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="inventory-items.csv"`,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
