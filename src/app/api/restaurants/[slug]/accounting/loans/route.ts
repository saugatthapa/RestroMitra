import { NextResponse } from "next/server";
import { db } from "@/db";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { recordLoanReceiptSchema } from "@/lib/validation/accounting";
import { listLoans, recordLoanReceipt, resolveMainBranchId } from "@/lib/accounting/loans";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Phase 5, Slice 5e — Loans. GET lists every loan this restaurant has
 * recorded (active and closed alike); POST records a new one and posts its
 * receipt voucher in the same transaction (see recordLoanReceipt's own doc
 * comment).
 */
export async function GET(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_ACCOUNTING);

    const loans = await db.transaction((tx) => listLoans(tx, restaurantId));
    return NextResponse.json({ loans });
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

    const parsed = await parseJsonBody(request, recordLoanReceiptSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const result = await db.transaction(async (tx) => {
      const branchId = await resolveMainBranchId(tx, restaurantId);
      return recordLoanReceipt(tx, {
        restaurantId,
        branchId,
        lenderName: data.lenderName,
        principalInPaisa: data.principal,
        interestRateBasisPoints:
          data.interestRatePercent != null ? Math.round(data.interestRatePercent * 100) : null,
        startDate: data.startDate,
        termMonths: data.termMonths ?? null,
        fundingMethod: data.fundingMethod,
        bankAccountId: data.bankAccountId || null,
        notes: data.notes || null,
        createdByUserId: session.user.id,
      });
    });

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "accounting.loan_received",
      resourceType: "loan",
      resourceId: result.loan.id,
      ipAddress: getClientIp(request),
      metadata: { lenderName: result.loan.lenderName, code: result.loan.code, principalInPaisa: data.principal },
    });

    return NextResponse.json({ loan: result.loan, voucher: result.voucher }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
