import { NextResponse } from "next/server";
import { db } from "@/db";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { createBankReconciliationSchema } from "@/lib/validation/accounting";
import { listBankReconciliations, createBankReconciliation } from "@/lib/accounting/bank-reconciliation";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/** `?bankAccountId=` narrows the list to one bank account's own reconciliation history. */
export async function GET(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_ACCOUNTING);

    const url = new URL(request.url);
    const bankAccountId = url.searchParams.get("bankAccountId") || undefined;

    const reconciliations = await db.transaction((tx) =>
      listBankReconciliations(tx, { restaurantId, bankAccountId }),
    );
    return NextResponse.json({ reconciliations });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_ACCOUNTING);

    const parsed = await parseJsonBody(request, createBankReconciliationSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const reconciliation = await db.transaction((tx) =>
      createBankReconciliation(tx, {
        restaurantId,
        bankAccountId: data.bankAccountId,
        statementDate: data.statementDate,
        statementClosingBalanceInPaisa: data.statementClosingBalance,
        notes: data.notes || null,
        createdByUserId: session.user.id,
      }),
    );

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "accounting.bank_reconciliation_created",
      resourceType: "bank_reconciliation",
      resourceId: reconciliation.id,
      ipAddress: getClientIp(request),
      metadata: { bankAccountId: data.bankAccountId, statementDate: data.statementDate },
    });

    return NextResponse.json({ reconciliation }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
