import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { suppliers } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { recordSupplierAdjustmentSchema } from "@/lib/validation/supplier-statement";
import { recordSupplierAdjustment } from "@/lib/ledger";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Records a manual credit/debit note against a supplier — a price
 * correction, a return credit, a late fee — outside the normal purchase
 * flow. See recordSupplierAdjustment's own doc comment (ledger.ts) for the
 * direction/sign convention: "debit" increases what this restaurant owes
 * the supplier, "credit" decreases it.
 *
 * Gated on MANAGE_ACCOUNT_BOOKS — same trust tier as every other entry
 * that moves a balance in Account Books (settle routes, the customer
 * credit settle route, the manual ledger-entry route).
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

    const parsed = await parseJsonBody(request, recordSupplierAdjustmentSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const entry = await db.transaction((tx) =>
      recordSupplierAdjustment(tx, {
        restaurantId,
        supplierId,
        direction: data.direction,
        amountInPaisa: data.amount,
        description: data.description,
        note: data.note || null,
        entryDate: data.entryDate,
        timezone,
        recordedByUserId: session.user.id,
      }),
    );

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "supplier.adjustment_recorded",
      resourceType: "supplier",
      resourceId: supplierId,
      ipAddress: getClientIp(request),
      metadata: { direction: data.direction, amountInPaisa: data.amount },
    });

    return NextResponse.json({ entry }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
