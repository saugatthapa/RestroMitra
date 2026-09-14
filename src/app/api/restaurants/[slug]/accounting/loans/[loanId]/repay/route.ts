import { NextResponse } from "next/server";
import { db } from "@/db";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { recordLoanRepaymentSchema } from "@/lib/validation/accounting";
import { recordLoanRepayment, resolveMainBranchId } from "@/lib/accounting/loans";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Records one repayment instalment against a loan — see
 * recordLoanRepayment's own doc comment for the full posting shape (a
 * manually-entered principal/interest split, per sign-off — no
 * amortization-schedule calculator).
 */
export async function POST(request: Request, ctx: { params: Promise<{ slug: string; loanId: string }> }) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, loanId } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_ACCOUNTING);

    const parsed = await parseJsonBody(request, recordLoanRepaymentSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const result = await db.transaction(async (tx) => {
      const branchId = await resolveMainBranchId(tx, restaurantId);
      return recordLoanRepayment(tx, {
        restaurantId,
        branchId,
        loanId,
        paymentDate: data.paymentDate,
        principalInPaisa: data.principal,
        interestInPaisa: data.interest,
        paymentMethod: data.paymentMethod,
        bankAccountId: data.bankAccountId || null,
        notes: data.notes || null,
        createdByUserId: session.user.id,
      });
    });

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "accounting.loan_repayment_recorded",
      resourceType: "loan",
      resourceId: loanId,
      ipAddress: getClientIp(request),
      metadata: { principalInPaisa: data.principal, interestInPaisa: data.interest },
    });

    return NextResponse.json({ loan: result.loan, voucher: result.voucher });
  } catch (err) {
    return toErrorResponse(err);
  }
}
