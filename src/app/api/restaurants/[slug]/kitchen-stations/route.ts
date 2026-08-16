import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { kitchenStations } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { createKitchenStationSchema } from "@/lib/validation/menu";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug);

    const rows = await db
      .select()
      .from(kitchenStations)
      .where(eq(kitchenStations.restaurantId, restaurantId))
      .orderBy(asc(kitchenStations.sortOrder));

    return NextResponse.json({ kitchenStations: rows });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(
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
      PERMISSIONS.EDIT_MENU,
    );

    const parsed = await parseJsonBody(request, createKitchenStationSchema);
    if (!parsed.ok) return parsed.response;

    const [station] = await db
      .insert(kitchenStations)
      .values({ restaurantId, name: parsed.data.name })
      .returning();

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "menu.kitchen_station.created",
      resourceType: "kitchen_station",
      resourceId: station.id,
      ipAddress: getClientIp(request),
      metadata: { name: station.name },
    });

    return NextResponse.json({ kitchenStation: station }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
