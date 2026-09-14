import { NextResponse } from "next/server";
import { db } from "@/db";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { updateBankReconciliationSchema } from "@/lib/validation/accounting";
import {
  getReconciliationWorkspace,
  setClearedLines,
  deleteOpenBankReconciliation,
} from "@/lib/accounting/bank-reconciliation";
import { bankReconciliations } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/** The reconciliation itself plus its full checklist of clearable/cleared voucher lines — see getReconciliationWorkspace's own doc comment. */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ slug: string; reconciliationId: string }> },
) {
  try {
    const { slug, reconciliationId } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_ACCOUNTING);

    const workspace = await db.transaction((tx) =>
      getReconciliationWorkspace(tx, { restaurantId, reconciliationId }),
    );
    return NextResponse.json(workspace);
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Updates an OPEN reconciliation's statement closing balance/notes, and/or
 * replaces its checked-off line set wholesale (see setClearedLines's own
 * doc comment on why the client always sends its full desired set, not a
 * delta).
 */
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ slug: string; reconciliationId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, reconciliationId } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_ACCOUNTING);

    const parsed = await parseJsonBody(request, updateBankReconciliationSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const result = await db.transaction(async (tx) => {
      if (data.statementClosingBalance !== undefined || data.notes !== undefined) {
        await tx
          .update(bankReconciliations)
          .set({
            statementClosingBalanceInPaisa: data.statementClosingBalance,
            notes: data.notes !== undefined ? data.notes || null : undefined,
            updatedAt: new Date(),
          })
          .where(and(eq(bankReconciliations.id, reconciliationId), eq(bankReconciliations.restaurantId, restaurantId)));
      }

      let skipped: string[] = [];
      if (data.clearedVoucherLineIds !== undefined) {
        const res = await setClearedLines(tx, {
          restaurantId,
          reconciliationId,
          voucherLineIds: data.clearedVoucherLineIds,
        });
        skipped = res.skipped;
      }

      return { workspace: await getReconciliationWorkspace(tx, { restaurantId, reconciliationId }), skipped };
    });

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "accounting.bank_reconciliation_updated",
      resourceType: "bank_reconciliation",
      resourceId: reconciliationId,
      ipAddress: getClientIp(request),
    });

    return NextResponse.json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** Deletes an abandoned, still-open reconciliation. A completed one can never be deleted — reopen it instead. */
export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ slug: string; reconciliationId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, reconciliationId } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_ACCOUNTING);

    await db.transaction((tx) => deleteOpenBankReconciliation(tx, { restaurantId, reconciliationId }));

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "accounting.bank_reconciliation_deleted",
      resourceType: "bank_reconciliation",
      resourceId: reconciliationId,
      ipAddress: getClientIp(request),
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
