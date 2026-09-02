import { NextResponse } from "next/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { branches, inventoryItems, ledgerEntries, purchaseItems, purchases, suppliers } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { createPurchaseSchema } from "@/lib/validation/inventory";
import { applyPurchaseCosting } from "@/lib/inventory";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { recordPurchaseLedgerEntry } from "@/lib/ledger";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { restaurantDate } from "@/lib/restaurant-date";
import { assertBusinessDayWritable } from "@/lib/daily-closing";

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId, branchId: grantedBranchId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_INVENTORY,
    );

    // QA hardening pass — purchases.branchId is NOT NULL (every purchase
    // belongs to exactly one branch), so a branch-scoped caller is simply
    // restricted to their own branch's purchases here.
    const rows = await db.query.purchases.findMany({
      where:
        grantedBranchId === null
          ? eq(purchases.restaurantId, restaurantId)
          : and(eq(purchases.restaurantId, restaurantId), eq(purchases.branchId, grantedBranchId)),
      orderBy: [desc(purchases.createdAt)],
      with: {
        supplier: true,
        items: { with: { inventoryItem: true } },
      },
      limit: 100,
    });

    // Each purchase's due/paid status lives on its linked ledgerEntries row
    // (referenceType="purchase"), not duplicated onto the purchase itself —
    // see recordPurchaseLedgerEntry's comment in ledger.ts. Looked up here
    // as one batched query rather than N+1 per purchase.
    const purchaseIds = rows.map((r) => r.id);
    const linkedLedgerEntries =
      purchaseIds.length === 0
        ? []
        : await db
            .select({
              id: ledgerEntries.id,
              referenceId: ledgerEntries.referenceId,
              amountInPaisa: ledgerEntries.amountInPaisa,
              dueStatus: ledgerEntries.dueStatus,
              settledAmountInPaisa: ledgerEntries.settledAmountInPaisa,
              isVoided: ledgerEntries.isVoided,
            })
            .from(ledgerEntries)
            .where(
              and(
                eq(ledgerEntries.restaurantId, restaurantId),
                eq(ledgerEntries.referenceType, "purchase"),
                inArray(ledgerEntries.referenceId, purchaseIds),
              ),
            );
    const ledgerByPurchaseId = new Map(linkedLedgerEntries.map((e) => [e.referenceId, e]));

    const purchasesWithLedger = rows.map((r) => ({
      ...r,
      ledgerEntry: ledgerByPurchaseId.get(r.id) ?? null,
    }));

    return NextResponse.json({ purchases: purchasesWithLedger });
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
    const { session, restaurantId, role, branchId: grantedBranchId, timezone } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_INVENTORY,
    );

    const parsed = await parseJsonBody(request, createPurchaseSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    // QA hardening pass — this used to only check the branch belonged to
    // the restaurant, not that it belonged to the CALLER. purchases/void
    // already enforces requireBranchAccess on the existing purchase; this
    // create route needs the equivalent check on the branch being written.
    await requireBranchAccess(session.user.id, restaurantId, data.branchId, {
      role,
      branchId: grantedBranchId,
    });
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
      // QA hardening pass (Phase 5 / centralized daily-close lock) —
      // purchases has no backdated "purchase date" field (only
      // createdAt/updatedAt — see getPurchasesSummary's own comment in
      // daily-closing.ts), so the business day this counts toward is
      // always "now", at the moment of the write.
      await assertBusinessDayWritable(
        {
          userId: session.user.id,
          restaurantId,
          branchId: data.branchId,
          businessDate: restaurantDate(timezone),
          role,
        },
        tx,
      );

      const [purchase] = await tx
        .insert(purchases)
        .values({
          restaurantId,
          branchId: data.branchId,
          supplierId: data.supplierId ?? null,
          invoiceNumber: data.invoiceNumber || null,
          totalInPaisa,
          notes: data.notes || null,
          isCredit: data.isCredit,
          dueDate: data.isCredit ? data.dueDate || null : null,
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

      // Booked as an immediately-settled debit by default. A credit
      // purchase (data.isCredit) books the same debit but marks it
      // "outstanding" on the ledger entry — settled later via the existing
      // generic /ledger/[entryId]/settle route (see recordPurchaseLedgerEntry's
      // own comment in ledger.ts). The ledger entry's id is looked up again
      // by the GET route below (never cached on the purchase row itself) so
      // there is exactly one place a due amount is tracked.
      const ledgerEntry = await recordPurchaseLedgerEntry(tx, {
        restaurantId,
        purchaseId: purchase.id,
        totalInPaisa,
        supplierName,
        invoiceNumber: purchase.invoiceNumber,
        timezone,
        markAsDue: data.isCredit,
        recordedByUserId: session.user.id,
        supplierId: data.supplierId ?? null,
      });

      return { purchase, items: insertedItems, ledgerEntry };
    });

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      branchId: data.branchId,
      action: "inventory.purchase.recorded",
      resourceType: "purchase",
      resourceId: result.purchase.id,
      ipAddress: getClientIp(request),
      metadata: { totalInPaisa, lineCount: lineTotals.length },
    });

    return NextResponse.json(
      { purchase: result.purchase, items: result.items, ledgerEntry: result.ledgerEntry },
      { status: 201 },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
