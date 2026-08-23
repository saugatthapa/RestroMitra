import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { branches, inventoryItems, purchaseItems, purchases, suppliers } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { createPurchaseSchema } from "@/lib/validation/inventory";
import { applyPurchaseCosting } from "@/lib/inventory";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { recordPurchaseLedgerEntry } from "@/lib/ledger";

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_INVENTORY);

    const rows = await db.query.purchases.findMany({
      where: eq(purchases.restaurantId, restaurantId),
      orderBy: [desc(purchases.createdAt)],
      with: {
        supplier: true,
        items: { with: { inventoryItem: true } },
      },
      limit: 100,
    });

    return NextResponse.json({ purchases: rows });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Records a purchase (stock-in): one purchase can span multiple inventory
 * items/line items. Every line item is validated to belong to THIS
 * restaurant before anything is written, then the whole purchase — the
 * purchase header, each purchase_items row, each item's recomputed
 * weighted-average cost, and each stock_movements "purchase" ledger entry —
 * commits atomically in a single transaction: a purchase is never left
 * half-applied (e.g. three of five ingredients costed and stocked in, two
 * not) if something fails partway through.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug } = await ctx.params;
    const { session, restaurantId, timezone } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_INVENTORY,
    );

    const parsed = await parseJsonBody(request, createPurchaseSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const ownedBranch = await db
      .select({ id: branches.id })
      .from(branches)
      .where(and(eq(branches.id, data.branchId), eq(branches.restaurantId, restaurantId)))
      .limit(1);
    if (ownedBranch.length === 0) {
      return NextResponse.json({ error: "Branch not found." }, { status: 404 });
    }

    let supplierName: string | null = null;
    if (data.supplierId) {
      const ownedSupplier = await db
        .select({ id: suppliers.id, name: suppliers.name })
        .from(suppliers)
        .where(and(eq(suppliers.id, data.supplierId), eq(suppliers.restaurantId, restaurantId)))
        .limit(1);
      if (ownedSupplier.length === 0) {
        return NextResponse.json({ error: "Supplier not found." }, { status: 404 });
      }
      supplierName = ownedSupplier[0].name;
    }

    // Verify every line item's inventory item belongs to this restaurant
    // up front — a cross-tenant id must fail cleanly with a 404, not
    // partway through the transaction.
    const ownedItemIds = new Set(
      (
        await db
          .select({ id: inventoryItems.id })
          .from(inventoryItems)
          .where(eq(inventoryItems.restaurantId, restaurantId))
      ).map((r) => r.id),
    );
    for (const line of data.items) {
      if (!ownedItemIds.has(line.inventoryItemId)) {
        return NextResponse.json({ error: "Inventory item not found." }, { status: 404 });
      }
    }

    const lineTotals = data.items.map((line) => ({
      ...line,
      lineTotalInPaisa: Math.round((line.quantity / 1000) * line.unitCost),
    }));
    const totalInPaisa = lineTotals.reduce((sum, l) => sum + l.lineTotalInPaisa, 0);

    const result = await db.transaction(async (tx) => {
      const [purchase] = await tx
        .insert(purchases)
        .values({
          restaurantId,
          branchId: data.branchId,
          supplierId: data.supplierId ?? null,
          invoiceNumber: data.invoiceNumber || null,
          totalInPaisa,
          notes: data.notes || null,
          recordedByUserId: session.user.id,
        })
        .returning();

      const insertedItems = [];
      for (const line of lineTotals) {
        const [purchaseItem] = await tx
          .insert(purchaseItems)
          .values({
            purchaseId: purchase.id,
            inventoryItemId: line.inventoryItemId,
            quantityMilliunits: line.quantity,
            unitCostInPaisa: line.unitCost,
            lineTotalInPaisa: line.lineTotalInPaisa,
          })
          .returning();
        insertedItems.push(purchaseItem);

        // Throwing InventoryError here (e.g. item not found for this
        // restaurant) rolls back the whole transaction via db.transaction
        // — the purchase header and any earlier line items in this same
        // request are undone too. Caught by the outer toErrorResponse().
        await applyPurchaseCosting(tx, {
          restaurantId,
          branchId: data.branchId,
          inventoryItemId: line.inventoryItemId,
          purchasedQuantityMilliunits: line.quantity,
          unitCostInPaisa: line.unitCost,
          purchaseId: purchase.id,
          recordedByUserId: session.user.id,
        });
      }

      // Booked as a debit/cash purchase by default — a supplier bought on
      // credit terms isn't tracked at this per-purchase level (see the
      // "purchase" category's own comment in ledger.ts); an owner who buys
      // on credit records the due via a manual Account Books entry instead.
      await recordPurchaseLedgerEntry(tx, {
        restaurantId,
        purchaseId: purchase.id,
        totalInPaisa,
        supplierName,
        invoiceNumber: purchase.invoiceNumber,
        timezone,
        recordedByUserId: session.user.id,
      });

      return { purchase, items: insertedItems };
    });

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "inventory.purchase.recorded",
      resourceType: "purchase",
      resourceId: result.purchase.id,
      ipAddress: getClientIp(request),
      metadata: { totalInPaisa, lineCount: lineTotals.length },
    });

    return NextResponse.json({ purchase: result.purchase, items: result.items }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
