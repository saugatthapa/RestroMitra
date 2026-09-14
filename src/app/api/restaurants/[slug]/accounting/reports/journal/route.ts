import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { getJournalReport } from "@/lib/accounting/journal-report";
import { reportDateSchema, accountingVoucherTypeSchema } from "@/lib/validation/accounting";
import { restaurantDate } from "@/lib/restaurant-date";

/**
 * Phase 7, Slice 7c — the accounting audit/journal report: every posted
 * voucher in a date range with its full debit/credit lines. `fromDate`/
 * `toDate` default to the current calendar month (same convention Cash
 * Flow's route already uses); `?voucherType=` optionally narrows to one
 * kind of business event; `?branchId=` follows the same security pattern
 * as every other report route in this module (Slice 7b) — forced to a
 * branch-restricted caller's own grant, or verified via
 * `requireBranchAccess` for an unrestricted caller's explicit request.
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
    } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_ACCOUNTING);

    const url = new URL(request.url);
    const fromDateParam = url.searchParams.get("fromDate");
    const toDateParam = url.searchParams.get("toDate");
    const parsedFrom = fromDateParam ? reportDateSchema.safeParse(fromDateParam) : undefined;
    const parsedTo = toDateParam ? reportDateSchema.safeParse(toDateParam) : undefined;
    const branchIdParam = url.searchParams.get("branchId");
    const voucherTypeParam = url.searchParams.get("voucherType");
    const parsedVoucherType = voucherTypeParam ? accountingVoucherTypeSchema.safeParse(voucherTypeParam) : undefined;

    const toDate = parsedTo?.success ? parsedTo.data : restaurantDate(timezone);
    const fromDate = parsedFrom?.success ? parsedFrom.data : `${toDate.slice(0, 7)}-01`;

    let effectiveBranchId: string | undefined;
    if (grantedBranchId) {
      effectiveBranchId = grantedBranchId;
    } else if (branchIdParam) {
      await requireBranchAccess(session.user.id, restaurantId, branchIdParam, { role, branchId: grantedBranchId });
      effectiveBranchId = branchIdParam;
    }

    const report = await getJournalReport({
      restaurantId,
      fromDate,
      toDate,
      branchId: effectiveBranchId,
      voucherType: parsedVoucherType?.success ? parsedVoucherType.data : undefined,
    });

    return NextResponse.json(report);
  } catch (err) {
    return toErrorResponse(err);
  }
}
