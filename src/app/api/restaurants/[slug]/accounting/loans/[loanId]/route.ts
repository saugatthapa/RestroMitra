import { NextResponse } from "next/server";
import { db } from "@/db";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { listLoans, listLoanPayments } from "@/lib/accounting/loans";
import { AccountingError } from "@/lib/accounting/post-voucher";

/** One loan's own detail, plus its full repayment history. */
export async function GET(request: Request, ctx: { params: Promise<{ slug: string; loanId: string }> }) {
  try {
    const { slug, loanId } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_ACCOUNTING);

    const [loan, payments] = await db.transaction(async (tx) => {
      const all = await listLoans(tx, restaurantId);
      const match = all.find((l) => l.id === loanId);
      if (!match) throw new AccountingError("Loan not found.", 404);
      const rows = await listLoanPayments(tx, { restaurantId, loanId });
      return [match, rows] as const;
    });

    return NextResponse.json({ loan, payments });
  } catch (err) {
    return toErrorResponse(err);
  }
}
