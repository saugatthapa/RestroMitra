import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { listPayrollPaymentsForExport } from "@/lib/payroll";
import { computePayslipTotals } from "@/lib/payslip";
import { PAYOUT_METHOD_LABELS } from "@/lib/finance/payout-methods";
import { paisaToRupees } from "@/lib/money";
import { toCsv } from "@/lib/csv";

// Same "everything for this range, not a paginated view" reasoning as the
// ledger export's own limit — see that route's comment. Higher than
// PAYROLL_LIST_LIMIT (500) on GET /payroll/payments for the same reason.
const EXPORT_ROW_LIMIT = 20_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Commercial completion pass — Data Export gap (payroll). Gated on
 * VIEW_PAYROLL — the same permission GET /payroll/payments (and the
 * payslip route) already require, deliberately NOT a bare staff-membership
 * check: salary information stays private per PERMISSIONS.VIEW_PAYROLL's
 * own catalog comment. `from`/`to` (YYYY-MM-DD) optionally narrow by
 * paidAt — see listPayrollPaymentsForExport's own comment for why that
 * column, not periodStart/periodEnd, is what's filtered.
 */
export async function GET(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId, branchId: grantedBranchId, timezone } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.VIEW_PAYROLL,
    );

    const url = new URL(request.url);
    const fromParam = url.searchParams.get("from");
    const toParam = url.searchParams.get("to");
    const from = fromParam && DATE_RE.test(fromParam) ? fromParam : undefined;
    const to = toParam && DATE_RE.test(toParam) ? toParam : undefined;

    const rows = await listPayrollPaymentsForExport(
      restaurantId,
      grantedBranchId,
      { from, to },
      timezone,
      EXPORT_ROW_LIMIT,
    );

    const csv = toCsv(rows, [
      { header: "Paid at", value: (r) => r.paidAt.toISOString() },
      { header: "Staff", value: (r) => r.staffNameSnapshot },
      { header: "Pay period", value: (r) => r.payPeriodLabel ?? "" },
      { header: "Period start", value: (r) => r.periodStart ?? "" },
      { header: "Period end", value: (r) => r.periodEnd ?? "" },
      { header: "Method", value: (r) => PAYOUT_METHOD_LABELS[r.paymentMethod] ?? r.paymentMethod },
      {
        header: "Base pay (Rs)",
        value: (r) => paisaToRupees(computePayslipTotals(r.amountInPaisa, r.deductionsJson).grossAmountInPaisa),
      },
      {
        header: "Deductions (Rs)",
        value: (r) => paisaToRupees(computePayslipTotals(r.amountInPaisa, r.deductionsJson).totalDeductionsInPaisa),
      },
      { header: "Net pay (Rs)", value: (r) => paisaToRupees(r.amountInPaisa) },
      { header: "Note", value: (r) => r.note ?? "" },
      { header: "Voided", value: (r) => r.isVoided },
    ]);

    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="payroll-payments${from ? `-${from}` : ""}${to ? `-to-${to}` : ""}.csv"`,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
