import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { getAccountLedger } from "@/lib/accounting/balances";

/** One account's full statement with a running balance — the Ledger Accounts screen. */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ slug: string; accountId: string }> },
) {
  try {
    const { slug, accountId } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_ACCOUNTING);

    const { account, lines } = await getAccountLedger({ restaurantId, accountId });
    if (!account) {
      return NextResponse.json({ error: "Account not found." }, { status: 404 });
    }

    return NextResponse.json({ account, lines });
  } catch (err) {
    return toErrorResponse(err);
  }
}
