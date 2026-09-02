import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { restaurants } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { updateTaxSettingsSchema } from "@/lib/validation/tax-settings";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Gap-audit P2 fix (fiscal compliance) — the restaurant's PAN/VAT
 * registration numbers (see the panNumber/vatNumber columns' own comment
 * in schema.ts for why these are separate from the older freeform
 * `panVat` field). Same "dedicated small route rather than a general
 * restaurant-profile endpoint, since there isn't one yet" shape as
 * kot-settings/route.ts — see that file's own doc comment; this exposes
 * just the fields the FiscalSettingsPanel needs.
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug);

    const [row] = await db
      .select({ panNumber: restaurants.panNumber, vatNumber: restaurants.vatNumber })
      .from(restaurants)
      .where(eq(restaurants.id, restaurantId))
      .limit(1);

    return NextResponse.json({
      panNumber: row?.panNumber ?? null,
      vatNumber: row?.vatNumber ?? null,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Gated MANAGE_RESTAURANT_SETTINGS — owner-only by default (not in any
 * role's DEFAULT_ROLE_PERMISSIONS grant), same trust tier as kot-settings
 * and branches/subscription. Both fields are independently optional (see
 * the schema column comment) — an owner can set just PAN, just VAT, both,
 * or clear either back out.
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

    const parsed = await parseJsonBody(request, updateTaxSettingsSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const nextPanNumber = data.panNumber && data.panNumber.length > 0 ? data.panNumber : null;
    const nextVatNumber = data.vatNumber && data.vatNumber.length > 0 ? data.vatNumber : null;

    const [updated] = await db
      .update(restaurants)
      .set({ panNumber: nextPanNumber, vatNumber: nextVatNumber, updatedAt: new Date() })
      .where(eq(restaurants.id, restaurantId))
      .returning({ panNumber: restaurants.panNumber, vatNumber: restaurants.vatNumber });

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "restaurant.tax_settings_updated",
      resourceType: "restaurant",
      resourceId: restaurantId,
      ipAddress: getClientIp(request),
      metadata: { panNumber: nextPanNumber, vatNumber: nextVatNumber },
    });

    return NextResponse.json({
      panNumber: updated?.panNumber ?? null,
      vatNumber: updated?.vatNumber ?? null,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
