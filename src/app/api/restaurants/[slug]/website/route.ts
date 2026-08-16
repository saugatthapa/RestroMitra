import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { getOrCreateWebsiteConfig, updateWebsiteConfig, buildSiteUrl } from "@/lib/website";
import { updateWebsiteSchema } from "@/lib/validation/website";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Reads this restaurant's Website Builder config — same trust tier as
 * MANAGE_RESTAURANT_SETTINGS (owner-only by default, see permissions.ts),
 * since a public website is branding/profile territory, not day-to-day
 * operations. Creates a default row on first access (see
 * getOrCreateWebsiteConfig) so the dashboard editor always has something
 * to render.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_RESTAURANT_SETTINGS);

    const config = await getOrCreateWebsiteConfig(restaurantId);
    const appUrl = process.env.APP_URL ?? "http://localhost:3000";

    return NextResponse.json({ website: config, siteUrl: buildSiteUrl(appUrl, slug) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** Applies a partial update to the website config — see updateWebsiteSchema for accepted fields. */
export async function PATCH(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_RESTAURANT_SETTINGS,
    );

    const parsed = await parseJsonBody(request, updateWebsiteSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const config = await updateWebsiteConfig(restaurantId, {
      ...data,
      tagline: data.tagline === "" ? null : data.tagline,
      aboutText: data.aboutText === "" ? null : data.aboutText,
      heroImageUrl: data.heroImageUrl === "" ? null : data.heroImageUrl,
      contactPhone: data.contactPhone === "" ? null : data.contactPhone,
      contactAddress: data.contactAddress === "" ? null : data.contactAddress,
      seoTitle: data.seoTitle === "" ? null : data.seoTitle,
      seoDescription: data.seoDescription === "" ? null : data.seoDescription,
    });

    if (data.isPublished !== undefined) {
      await recordAuditLog({
        restaurantId,
        userId: session.user.id,
        action: data.isPublished ? "website.published" : "website.unpublished",
        resourceType: "restaurant_website",
        resourceId: config.id,
        ipAddress: getClientIp(request),
      });
    }

    const appUrl = process.env.APP_URL ?? "http://localhost:3000";
    return NextResponse.json({ website: config, siteUrl: buildSiteUrl(appUrl, slug) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
