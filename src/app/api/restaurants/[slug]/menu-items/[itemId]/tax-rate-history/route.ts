import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { menuItems, menuItemTaxRateHistory, users } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";

async function getOwnedMenuItem(restaurantId: string, itemId: string) {
  const rows = await db
    .select({ id: menuItems.id })
    .from(menuItems)
    .where(and(eq(menuItems.id, itemId), eq(menuItems.restaurantId, restaurantId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Phase 6, Slice 6b — read-only history of this menu item's own tax rate
 * changes (`menu_item_tax_rate_history` — see that table's comment in
 * schema.ts for why it exists and how it relates to
 * menuItems.taxRateBasisPoints). Gated behind EDIT_MENU, the same
 * permission that already lets staff view/edit this item's tax rate at
 * all — deliberately NOT the separate, stricter, unrestricted-only
 * MANAGE_STAFF-gated restaurant-wide audit log (audit-log/route.ts): that
 * log is a cross-cutting activity feed for owners/managers, while this is
 * a focused answer to "what was this one item's rate, and when did it
 * change" for whoever is already looking at the item.
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ slug: string; itemId: string }> },
) {
  try {
    const { slug, itemId } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.EDIT_MENU);

    const item = await getOwnedMenuItem(restaurantId, itemId);
    if (!item) {
      return NextResponse.json({ error: "Menu item not found." }, { status: 404 });
    }

    const rows = await db
      .select({
        id: menuItemTaxRateHistory.id,
        taxRateBasisPoints: menuItemTaxRateHistory.taxRateBasisPoints,
        effectiveFrom: menuItemTaxRateHistory.effectiveFrom,
        createdAt: menuItemTaxRateHistory.createdAt,
        createdByName: users.fullName,
      })
      .from(menuItemTaxRateHistory)
      .innerJoin(users, eq(users.id, menuItemTaxRateHistory.createdByUserId))
      .where(eq(menuItemTaxRateHistory.menuItemId, itemId))
      .orderBy(desc(menuItemTaxRateHistory.effectiveFrom));

    return NextResponse.json({ history: rows });
  } catch (err) {
    return toErrorResponse(err);
  }
}
