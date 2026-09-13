import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { getAccountBalances } from "@/lib/accounting/balances";

/**
 * Phase 2's Overview shell — per-account balances plus a restaurant-wide
 * total by account type. Not a Trial Balance/P&L/Balance Sheet report
 * (that's Phase 3) — just enough for the UI to show something meaningful
 * while it's mostly manually-entered data (Phase 4 hasn't wired anything
 * in yet).
 */
export async function GET(_request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_ACCOUNTING);

    const { accounts, totalsByType } = await getAccountBalances({ restaurantId });

    return NextResponse.json({ accounts, totalsByType });
  } catch (err) {
    return toErrorResponse(err);
  }
}
