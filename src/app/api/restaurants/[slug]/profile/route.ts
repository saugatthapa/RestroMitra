import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { restaurants } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { updateRestaurantProfileSchema } from "@/lib/validation/restaurant-profile";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

const PROFILE_COLUMNS = {
  name: restaurants.name,
  logoUrl: restaurants.logoUrl,
  phone: restaurants.phone,
  address: restaurants.address,
  city: restaurants.city,
  district: restaurants.district,
} as const;

/**
 * The general restaurant-profile endpoint referenced (as not-yet-existing)
 * by kot-settings/route.ts and tax-settings/route.ts's own doc comments —
 * backs the dashboard's Settings page, which used to be a permanent
 * "Coming soon" placeholder (see DashboardShell.tsx's nav item). Covers the
 * fields set once at onboarding (src/lib/onboarding.ts) that had no
 * self-service edit path anywhere afterward: name, logo, phone, address,
 * city, district. PAN/VAT and the KOT ticket header stay on their own
 * existing routes rather than getting duplicated here — the Settings page
 * calls all three.
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug);

    const [row] = await db
      .select(PROFILE_COLUMNS)
      .from(restaurants)
      .where(eq(restaurants.id, restaurantId))
      .limit(1);

    if (!row) {
      return NextResponse.json({ error: "Restaurant not found." }, { status: 404 });
    }

    return NextResponse.json(row);
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Gated MANAGE_RESTAURANT_SETTINGS — owner-only by default, same trust tier
 * as kot-settings/tax-settings. Every field is required (unlike those two
 * optional-override routes) because these are the restaurant's core
 * identity/contact fields — a blank name or phone isn't a valid "cleared"
 * state the way an unset PAN number is.
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

    const parsed = await parseJsonBody(request, updateRestaurantProfileSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const nextLogoUrl = data.logoUrl && data.logoUrl.length > 0 ? data.logoUrl : null;

    const [updated] = await db
      .update(restaurants)
      .set({
        name: data.name,
        logoUrl: nextLogoUrl,
        phone: data.phone,
        address: data.address,
        city: data.city,
        district: data.district,
        updatedAt: new Date(),
      })
      .where(eq(restaurants.id, restaurantId))
      .returning(PROFILE_COLUMNS);

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "restaurant.profile_updated",
      resourceType: "restaurant",
      resourceId: restaurantId,
      ipAddress: getClientIp(request),
      metadata: {
        name: data.name,
        phone: data.phone,
        city: data.city,
        district: data.district,
        logoChanged: nextLogoUrl !== null,
      },
    });

    return NextResponse.json(updated);
  } catch (err) {
    return toErrorResponse(err);
  }
}
