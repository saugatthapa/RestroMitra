import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { getTallyExport } from "@/lib/accounting/tally-export";
import { reportDateSchema } from "@/lib/validation/accounting";
import { restaurantDate } from "@/lib/restaurant-date";

/**
 * Phase 7, Slice 7f — Tally-compatible export. See tally-export.ts's own
 * top-of-file comment: UNVERIFIED against real Tally software in this
 * environment. `?format=json` returns a small summary (voucher count, any
 * skipped voucher numbers) for the UI's own preview panel; the default
 * response is the actual downloadable XML file, following this codebase's
 * existing CSV-export convention (Content-Disposition: attachment) — see
 * purchases/export/route.ts.
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

    const toDate = parsedTo?.success ? parsedTo.data : restaurantDate(timezone);
    const fromDate = parsedFrom?.success ? parsedFrom.data : `${toDate.slice(0, 7)}-01`;

    let effectiveBranchId: string | undefined;
    if (grantedBranchId) {
      effectiveBranchId = grantedBranchId;
    } else if (branchIdParam) {
      await requireBranchAccess(session.user.id, restaurantId, branchIdParam, { role, branchId: grantedBranchId });
      effectiveBranchId = branchIdParam;
    }

    const result = await getTallyExport({ restaurantId, fromDate, toDate, branchId: effectiveBranchId });

    if (url.searchParams.get("format") === "json") {
      return NextResponse.json({
        fromDate: result.fromDate,
        toDate: result.toDate,
        voucherCount: result.voucherCount,
        skippedVoucherNumbers: result.skippedVoucherNumbers,
      });
    }

    return new NextResponse(result.xml, {
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Content-Disposition": `attachment; filename="tally-export-${fromDate}-to-${toDate}.xml"`,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
