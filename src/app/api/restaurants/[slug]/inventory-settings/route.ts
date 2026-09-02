import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { restaurants } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { updateInventorySettingsSchema } from "@/lib/validation/inventory";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * P2 gap audit — "negative stock is always allowed by deliberate, disclosed
 * design, with no restaurant-level toggle to disallow it." This is that
 * toggle: `restaurants.allowNegativeStock` (default true, preserving the
 * original behavior for every existing restaurant), read/written here and
 * actually enforced in recordStockMovement (src/lib/inventory.ts) — the
 * single choke point every stock deduction in this app goes through
 * (sale-deduction on order confirm, manual adjustments, waste, stock-count
 * variances, and stock-transfer dispatch).
 *
 * Its own tiny route rather than a general restaurant-profile endpoint,
 * same "no such endpoint exists yet" reasoning as kot-settings/attendance's
 * settings route, which this deliberately mirrors.
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug);

    const [row] = await db
      .select({ allowNegativeStock: restaurants.allowNegativeStock })
      .from(restaurants)
      .where(eq(restaurants.id, restaurantId))
      .limit(1);

    return NextResponse.json({ allowNegativeStock: row?.allowNegativeStock ?? true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Gated MANAGE_RESTAURANT_SETTINGS — owner-only by default, same
 * "structural configuration" trust tier as kot-settings/attendance-settings/
 * branches/subscription. A line cook adjusting stock all day never needs to
 * touch this, only whoever owns whether the restaurant blocks or allows
 * going below zero.
 */
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_RESTAURANT_SETTINGS,
    );

    const parsed = await parseJsonBody(request, updateInventorySettingsSchema);
    if (!parsed.ok) return parsed.response;

    const [updated] = await db
      .update(restaurants)
      .set({ allowNegativeStock: parsed.data.allowNegativeStock, updatedAt: new Date() })
      .where(eq(restaurants.id, restaurantId))
      .returning({ allowNegativeStock: restaurants.allowNegativeStock });

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "restaurant.inventory_settings_updated",
      resourceType: "restaurant",
      resourceId: restaurantId,
      ipAddress: getClientIp(request),
      metadata: { allowNegativeStock: parsed.data.allowNegativeStock },
    });

    return NextResponse.json({ allowNegativeStock: updated?.allowNegativeStock ?? true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
