import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { restaurantTables } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { recordCombinedPaymentSchema } from "@/lib/validation/payments";
import { getCombinedBillForTable, recordCombinedPayment } from "@/lib/combined-billing";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

async function getOwnedTable(restaurantId: string, tableId: string) {
  const rows = await db
    .select({ id: restaurantTables.id, branchId: restaurantTables.branchId })
    .from(restaurantTables)
    .where(and(eq(restaurantTables.id, tableId), eq(restaurantTables.restaurantId, restaurantId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Combine bill — Commercial Launch follow-up requested right after Table
 * Merge shipped: merging only ever reassigns which table an order sits on
 * (see mergeTables in tables.ts), it never folds multiple orders into one,
 * so a merged table routinely still needs its orders paid off separately.
 * This is the "one bill, one payment for the whole table" view: GET reads
 * every active order on the table plus the combined total due (what a
 * cashier would see before charging anything), POST records one payment
 * against all of them at once — see recordCombinedPayment's own doc
 * comment in combined-billing.ts for exactly how it's allocated.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ slug: string; tableId: string }> },
) {
  try {
    const { slug, tableId } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug);

    const existing = await getOwnedTable(restaurantId, tableId);
    if (!existing) {
      return NextResponse.json({ error: "Table not found." }, { status: 404 });
    }

    const summary = await db.transaction((tx) => getCombinedBillForTable(tx, { restaurantId, tableId }));
    return NextResponse.json(summary);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string; tableId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, tableId } = await ctx.params;
    // Same permission tier as the single-order payments route — recording
    // what was paid is ordinary order handling, not a privileged action.
    const { session, restaurantId, role, timezone, branchId: grantedBranchId } =
      await resolveRestaurantContext(slug, PERMISSIONS.EDIT_ORDER);

    const existing = await getOwnedTable(restaurantId, tableId);
    if (!existing) {
      return NextResponse.json({ error: "Table not found." }, { status: 404 });
    }
    await requireBranchAccess(session.user.id, restaurantId, existing.branchId, {
      role,
      branchId: grantedBranchId,
    });

    const parsed = await parseJsonBody(request, recordCombinedPaymentSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const result = await db.transaction((tx) =>
      recordCombinedPayment(tx, {
        restaurantId,
        tableId,
        amountInPaisa: body.amount,
        method: body.method,
        note: body.note || null,
        clientRequestId: body.clientRequestId || null,
        recordedByUserId: session.user.id,
        timezone,
        role,
      }),
    );

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "table.combined_bill_paid",
      resourceType: "table",
      resourceId: tableId,
      ipAddress: getClientIp(request),
      metadata: {
        amountInPaisa: body.amount,
        method: body.method,
        touchedOrderIds: result.touchedOrderIds,
        payments: result.payments,
      },
    });

    const summary = await db.transaction((tx) => getCombinedBillForTable(tx, { restaurantId, tableId }));
    return NextResponse.json({ ...result, ...summary }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
