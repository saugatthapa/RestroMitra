import { NextResponse } from "next/server";
import { db } from "@/db";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { updateBankAccountSchema } from "@/lib/validation/accounting";
import { updateBankAccount } from "@/lib/accounting/bank-accounts";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Renames/edits a bank account, or toggles it active — see
 * updateBankAccount's own doc comment for why toggling active also
 * toggles its wrapped ledger account, with no separate "is this load-
 * bearing" guard the way a mapped control account needs (a bank account's
 * ledger row is never shared via account_mappings).
 */
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ slug: string; bankAccountId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, bankAccountId } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_ACCOUNTING);

    const parsed = await parseJsonBody(request, updateBankAccountSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const bankAccount = await db.transaction((tx) =>
      updateBankAccount(tx, {
        restaurantId,
        bankAccountId,
        bankName: data.bankName,
        accountNumber: data.accountNumber,
        branchName: data.branchName,
        notes: data.notes,
        isActive: data.isActive,
      }),
    );

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "accounting.bank_account_updated",
      resourceType: "bank_account",
      resourceId: bankAccount.id,
      ipAddress: getClientIp(request),
      metadata: { isActive: bankAccount.isActive },
    });

    return NextResponse.json({ bankAccount });
  } catch (err) {
    return toErrorResponse(err);
  }
}
