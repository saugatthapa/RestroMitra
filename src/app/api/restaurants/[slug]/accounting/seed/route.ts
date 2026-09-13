import { NextResponse } from "next/server";
import { db } from "@/db";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { seedDefaultChartOfAccounts } from "@/lib/accounting/chart-of-accounts";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * One-time (but safely repeatable) setup action: creates the default chart
 * of accounts + account_mappings from ACCOUNTING_POLICY_AND_POSTING_MATRIX.md
 * for this restaurant. An explicit action rather than something that
 * happens automatically on first visit to the (future) Accounting section,
 * so there's a clear audit trail of exactly when a restaurant turned this
 * module on. Safe to call again later (e.g. after a partial failure, or if
 * a future release adds a new default account) — seedDefaultChartOfAccounts
 * only ever inserts rows that don't already exist.
 */
export async function POST(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_ACCOUNTING,
    );

    const result = await db.transaction((tx) => seedDefaultChartOfAccounts(tx, { restaurantId }));

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "accounting.chart_seeded",
      resourceType: "restaurant",
      resourceId: restaurantId,
      ipAddress: getClientIp(request),
      metadata: result,
    });

    return NextResponse.json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
