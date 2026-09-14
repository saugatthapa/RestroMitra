import { NextResponse } from "next/server";
import { db } from "@/db";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { reopenBankReconciliation } from "@/lib/accounting/bank-reconciliation";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/** Reopens a completed reconciliation for correction — see reopenBankReconciliation's own doc comment. */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string; reconciliationId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, reconciliationId } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_ACCOUNTING);

    const reconciliation = await db.transaction((tx) => reopenBankReconciliation(tx, { restaurantId, reconciliationId }));

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "accounting.bank_reconciliation_reopened",
      resourceType: "bank_reconciliation",
      resourceId: reconciliationId,
      ipAddress: getClientIp(request),
    });

    return NextResponse.json({ reconciliation });
  } catch (err) {
    return toErrorResponse(err);
  }
}
