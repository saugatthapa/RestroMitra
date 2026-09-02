import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { listOrdersForExport } from "@/lib/orders";
import { ORDER_STATUS_LABELS } from "@/lib/order-status";
import { PAYMENT_STATUS_LABELS } from "@/lib/payments";
import { paisaToRupees } from "@/lib/money";
import { restaurantDate } from "@/lib/restaurant-date";
import { toCsv } from "@/lib/csv";

// Same "everything for this range, not a paginated view" reasoning as the
// ledger export's own limit — see that route's comment.
const EXPORT_ROW_LIMIT = 20_000;
const MAX_RANGE_DAYS = 366;
const DEFAULT_RANGE_DAYS = 30;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function daysAgoIso(timezone: string, days: number) {
  return restaurantDate(timezone, new Date(Date.now() - days * 86_400_000));
}

/**
 * Commercial completion pass — Data Export gap (orders). Gated on
 * VIEW_SALES rather than the bare-membership check GET /orders itself uses
 * — that route is a real-time "live board" any staff member needs to work
 * a shift; this is a historical sales report over an arbitrary date range,
 * the same trust tier reports/summary already draws that line at (see this
 * route's `from`/`to` handling, deliberately mirrored from that route).
 * Row shape/query come from listOrdersForExport (src/lib/orders.ts) rather
 * than GET /orders' own query — see that function's own comment for why.
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
    } = await resolveRestaurantContext(slug, PERMISSIONS.VIEW_SALES);

    const url = new URL(request.url);
    const fromParam = url.searchParams.get("from");
    const toParam = url.searchParams.get("to");
    const branchIdParam = url.searchParams.get("branchId");

    let from = fromParam && DATE_RE.test(fromParam) ? fromParam : daysAgoIso(timezone, DEFAULT_RANGE_DAYS - 1);
    let to = toParam && DATE_RE.test(toParam) ? toParam : restaurantDate(timezone);

    const spanDays = (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000;
    if (Number.isNaN(spanDays) || spanDays < 0 || spanDays > MAX_RANGE_DAYS) {
      from = daysAgoIso(timezone, DEFAULT_RANGE_DAYS - 1);
      to = restaurantDate(timezone);
    }

    let effectiveBranchId: string | undefined;
    if (grantedBranchId) {
      effectiveBranchId = grantedBranchId;
    } else if (branchIdParam) {
      await requireBranchAccess(session.user.id, restaurantId, branchIdParam, {
        role,
        branchId: grantedBranchId,
      });
      effectiveBranchId = branchIdParam;
    }

    const rows = await listOrdersForExport(
      restaurantId,
      { from, to, branchId: effectiveBranchId },
      timezone,
      EXPORT_ROW_LIMIT,
    );

    const csv = toCsv(rows, [
      { header: "Order number", value: (r) => r.orderNumber },
      { header: "Placed at", value: (r) => r.placedAt.toISOString() },
      { header: "Branch", value: (r) => r.branchName ?? "" },
      { header: "Table", value: (r) => r.tableName ?? "" },
      { header: "Source", value: (r) => r.source },
      { header: "Status", value: (r) => ORDER_STATUS_LABELS[r.status] },
      { header: "Payment status", value: (r) => PAYMENT_STATUS_LABELS[r.paymentStatus] },
      { header: "Customer", value: (r) => r.customerName ?? "" },
      { header: "Customer phone", value: (r) => r.customerPhone ?? "" },
      { header: "Subtotal (Rs)", value: (r) => paisaToRupees(r.subtotalInPaisa) },
      { header: "Discount (Rs)", value: (r) => paisaToRupees(r.discountInPaisa) },
      { header: "Service charge (Rs)", value: (r) => paisaToRupees(r.serviceChargeInPaisa) },
      { header: "Tax (Rs)", value: (r) => paisaToRupees(r.taxInPaisa) },
      { header: "Total (Rs)", value: (r) => paisaToRupees(r.totalInPaisa) },
    ]);

    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="orders-${from}-to-${to}.csv"`,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
