import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { suppliers } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { recordSupplierPaymentSchema } from "@/lib/validation/supplier-statement";
import { recordSupplierPayment } from "@/lib/ledger";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Records a lump-sum payment against a supplier's outstanding credit-
 * purchase dues, applied oldest-due-first (see recordSupplierPayment's own
 * doc comment in ledger.ts — mirrors settleCustomerCredit exactly). This is
 * the Supplier Statement page's own "record payment" action; the existing
 * per-purchase settle route (POST /ledger/[entryId]/settle, used by the
 * Supplier Dues report's per-row "Record payment" button) still works
 * unchanged for the rarer case of targeting one purchase specifically.
 *
 * Gated on MANAGE_ACCOUNT_BOOKS, same segregation of duties as every other
 * due-settlement route in this app (see the customer credit settle route's
 * own comment). A 409 here means someone else settled part of this
 * supplier's balance a moment ago; the client should refresh and re-check
 * before retrying.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string; supplierId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, supplierId } = await ctx.params;
    const { session, restaurantId, timezone } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_ACCOUNT_BOOKS,
    );

    const [supplier] = await db
      .select({ id: suppliers.id })
      .from(suppliers)
      .where(and(eq(suppliers.id, supplierId), eq(suppliers.restaurantId, restaurantId)))
      .limit(1);
    if (!supplier) {
      return NextResponse.json({ error: "Supplier not found." }, { status: 404 });
    }

    const parsed = await parseJsonBody(request, recordSupplierPaymentSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const result = await db.transaction((tx) =>
      recordSupplierPayment(tx, {
        restaurantId,
        supplierId,
        amountInPaisa: data.amount,
        note: data.note || null,
        timezone,
        recordedByUserId: session.user.id,
      }),
    );

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "supplier.payment_recorded",
      resourceType: "supplier",
      resourceId: supplierId,
      ipAddress: getClientIp(request),
      metadata: { appliedInPaisa: result.appliedInPaisa, entriesSettled: result.settlements.length },
    });

    return NextResponse.json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
