import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { restaurants } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { getAccountBalances } from "@/lib/accounting/balances";

/**
 * Phase 2's Overview shell — per-account balances plus a restaurant-wide
 * total by account type. Also reports Phase 4's automaticPostingEnabledAt
 * flag (null until explicitly enabled — see the enable-automatic-posting
 * route) so the UI can show the right call to action: seed a chart of
 * accounts, then separately enable automatic posting, then (once enabled)
 * a plain confirmation rather than the button again.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_ACCOUNTING);

    const [{ accounts, totalsByType }, [restaurant]] = await Promise.all([
      getAccountBalances({ restaurantId }),
      db
        .select({ automaticPostingEnabledAt: restaurants.automaticPostingEnabledAt })
        .from(restaurants)
        .where(eq(restaurants.id, restaurantId))
        .limit(1),
    ]);

    return NextResponse.json({
      accounts,
      totalsByType,
      automaticPostingEnabledAt: restaurant?.automaticPostingEnabledAt ?? null,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
