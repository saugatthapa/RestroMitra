import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { restaurants } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { updateKotSettingsSchema } from "@/lib/validation/kot-settings";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * The Kitchen Order Ticket's configurable header text (see kot-ticket.ts's
 * resolveKotHeaderText) — the "custom header config" piece of Phase 17's
 * KOT system. Deliberately its own tiny route rather than folded into a
 * general restaurant-profile endpoint, since there isn't one yet (the
 * dashboard Settings page is still a "Coming soon" placeholder) — this
 * exposes just the one field the KDS page's ticket-settings panel needs,
 * without standing up the full restaurant-profile surface early.
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug);

    const [row] = await db
      .select({ name: restaurants.name, kotHeaderText: restaurants.kotHeaderText })
      .from(restaurants)
      .where(eq(restaurants.id, restaurantId))
      .limit(1);

    return NextResponse.json({ restaurantName: row?.name ?? "", kotHeaderText: row?.kotHeaderText ?? null });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Gated MANAGE_RESTAURANT_SETTINGS — owner-only by default (not in any
 * role's DEFAULT_ROLE_PERMISSIONS grant), same "structural configuration"
 * trust tier as branches/subscription. A cashier printing tickets all day
 * never needs to touch this, only whoever owns how the kitchen sees the
 * restaurant's name.
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

    const parsed = await parseJsonBody(request, updateKotSettingsSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const nextValue = data.kotHeaderText && data.kotHeaderText.length > 0 ? data.kotHeaderText : null;

    const [updated] = await db
      .update(restaurants)
      .set({ kotHeaderText: nextValue, updatedAt: new Date() })
      .where(eq(restaurants.id, restaurantId))
      .returning({ name: restaurants.name, kotHeaderText: restaurants.kotHeaderText });

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "restaurant.kot_settings_updated",
      resourceType: "restaurant",
      resourceId: restaurantId,
      ipAddress: getClientIp(request),
      metadata: { kotHeaderText: nextValue },
    });

    return NextResponse.json({
      restaurantName: updated?.name ?? "",
      kotHeaderText: updated?.kotHeaderText ?? null,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
