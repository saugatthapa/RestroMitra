import { NextResponse } from "next/server";
import { db } from "@/db";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { completeBankReconciliation } from "@/lib/accounting/bank-reconciliation";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Completes an open reconciliation — see completeBankReconciliation's own
 * doc comment for the balance/difference arithmetic. A real difference is
 * NOT an error here (it's recorded, not blocked) — the response's
 * `differenceInPaisa` tells the UI whether to show a "fully reconciled"
 * or "difference found" state.
 */
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

    const reconciliation = await db.transaction((tx) =>
      completeBankReconciliation(tx, { restaurantId, reconciliationId, completedByUserId: session.user.id }),
    );

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "accounting.bank_reconciliation_completed",
      resourceType: "bank_reconciliation",
      resourceId: reconciliationId,
      ipAddress: getClientIp(request),
      metadata: { differenceInPaisa: reconciliation.differenceInPaisa },
    });

    return NextResponse.json({ reconciliation });
  } catch (err) {
    return toErrorResponse(err);
  }
}
