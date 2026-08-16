import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { restaurantTables } from "@/db/schema";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { buildOrderUrl, renderQrPng } from "@/lib/qr";

export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/restaurants/[slug]/tables/[tableId]/qr">,
) {
  try {
    const { slug, tableId } = await ctx.params;
    // Viewing/printing a QR code is a read of already-scoped data, not a
    // structural change — any staff member with restaurant access (not
    // just MANAGE_TABLES holders) can fetch it, mirroring the read/write
    // split used elsewhere (e.g. menu GET vs POST).
    const { restaurantId } = await resolveRestaurantContext(slug);

    const rows = await db
      .select()
      .from(restaurantTables)
      .where(and(eq(restaurantTables.id, tableId), eq(restaurantTables.restaurantId, restaurantId)))
      .limit(1);
    const table = rows[0];
    if (!table) {
      return NextResponse.json({ error: "Table not found." }, { status: 404 });
    }

    const appUrl = process.env.APP_URL ?? "http://localhost:3000";
    const orderUrl = buildOrderUrl(appUrl, table.qrToken);
    const png = await renderQrPng(orderUrl);

    return new NextResponse(new Uint8Array(png), {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "private, max-age=60",
        "Content-Disposition": `inline; filename="table-${table.name.replace(/[^a-z0-9]+/gi, "-")}-qr.png"`,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
