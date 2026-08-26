import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { reconciliationQuerySchema } from "@/lib/validation/payments";
import { listPaymentsForReconciliation } from "@/lib/financial-reconciliation";
import { PAYMENT_METHOD_LABELS } from "@/lib/payments";
import { paisaToRupees } from "@/lib/money";
import { toCsv } from "@/lib/csv";

// Same "everything for this range, not a paginated view" reasoning as the
// ledger export's own limit — see that route's comment.
const EXPORT_ROW_LIMIT = 20_000;

/**
 * Commercial Launch Phase B.5 — Data Export. CSV export of Payment
 * Reconciliation rows, gated on the same MANAGE_ACCOUNT_BOOKS permission
 * as GET /reconciliation (see that route + financial-reconciliation.ts's
 * module doc comment for why no new permission was introduced and why
 * "cash" never appears here). Filters mirror that route exactly, reusing
 * listPaymentsForReconciliation at a higher row limit.
 */
export async function GET(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const {
      session,
      restaurantId,
      role,
      branchId: grantedBranchId,
      timezone,
    } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_ACCOUNT_BOOKS);

    const url = new URL(request.url);
    const parsed = reconciliationQuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid query parameters." }, { status: 400 });
    }

    let effectiveBranchId: string | undefined;
    if (grantedBranchId) {
      effectiveBranchId = grantedBranchId;
    } else if (parsed.data.branchId) {
      await requireBranchAccess(session.user.id, restaurantId, parsed.data.branchId, {
        role,
        branchId: grantedBranchId,
      });
      effectiveBranchId = parsed.data.branchId;
    }

    const rows = await listPaymentsForReconciliation(
      restaurantId,
      {
        branchId: effectiveBranchId,
        method: parsed.data.method,
        from: parsed.data.from,
        to: parsed.data.to,
      },
      parsed.data.status ?? "unreconciled",
      EXPORT_ROW_LIMIT,
      timezone,
    );

    const csv = toCsv(rows, [
      { header: "Date", value: (r) => r.createdAt.toISOString() },
      { header: "Order", value: (r) => r.orderNumber },
      { header: "Method", value: (r) => PAYMENT_METHOD_LABELS[r.method] },
      { header: "Amount (Rs)", value: (r) => paisaToRupees(r.amountInPaisa) },
      { header: "Status", value: (r) => (r.reconciledAt ? "Reconciled" : "Unreconciled") },
      { header: "Reconciled at", value: (r) => (r.reconciledAt ? r.reconciledAt.toISOString() : "") },
      { header: "Note", value: (r) => r.note ?? "" },
    ]);

    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="reconciliation-${parsed.data.status ?? "unreconciled"}.csv"`,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
