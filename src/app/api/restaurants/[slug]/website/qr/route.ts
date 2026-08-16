import { NextResponse } from "next/server";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { buildSiteUrl } from "@/lib/website";
import { renderQrPng } from "@/lib/qr";

/**
 * A downloadable/printable QR code pointing at this restaurant's public
 * website — the "QR menu embed" a restaurant can put on a table tent,
 * signboard, or flyer. Reuses renderQrPng (same lib as table-ordering QR
 * codes); gated the same as the website config itself since it encodes the
 * live public URL regardless of publish state (letting an owner preview
 * the code before actually publishing).
 */
export async function GET(_request: Request, ctx: RouteContext<"/api/restaurants/[slug]/website/qr">) {
  try {
    const { slug } = await ctx.params;
    await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_RESTAURANT_SETTINGS);

    const appUrl = process.env.APP_URL ?? "http://localhost:3000";
    const siteUrl = buildSiteUrl(appUrl, slug);
    const png = await renderQrPng(siteUrl);

    return new NextResponse(new Uint8Array(png), {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "private, max-age=60",
        "Content-Disposition": `inline; filename="${slug}-website-qr.png"`,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
