import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { getAccountingHealthReport } from "@/lib/accounting/health-check";

/**
 * Phase 7, Slice 7e — the Accounting Health validator. Read-only
 * diagnostics only (see health-check.ts's own top-of-file comment) — this
 * route never writes anything. Deliberately not branch-scoped and not
 * date-ranged: this checks the state of the whole restaurant's books as
 * of today, not a period report.
 */
export async function GET(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId, timezone } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_ACCOUNTING);

    const report = await getAccountingHealthReport({ restaurantId, timezone });

    return NextResponse.json({ report });
  } catch (err) {
    return toErrorResponse(err);
  }
}
