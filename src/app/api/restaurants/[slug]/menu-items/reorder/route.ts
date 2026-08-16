import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { menuItems } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { reorderItemsSchema } from "@/lib/validation/menu";
import { hasValidCsrfHeader } from "@/lib/request";

export async function POST(
  request: Request,
  ctx: RouteContext<"/api/restaurants/[slug]/menu-items/reorder">,
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.EDIT_MENU);

    const parsed = await parseJsonBody(request, reorderItemsSchema);
    if (!parsed.ok) return parsed.response;
    const { categoryId, orderedIds } = parsed.data;

    const owned = await db
      .select({ id: menuItems.id })
      .from(menuItems)
      .where(and(eq(menuItems.restaurantId, restaurantId), eq(menuItems.categoryId, categoryId)));
    const ownedIds = new Set(owned.map((i) => i.id));
    if (!orderedIds.every((id) => ownedIds.has(id))) {
      return NextResponse.json(
        { error: "One or more items do not belong to this category/restaurant." },
        { status: 403 },
      );
    }

    await db.transaction(async (tx) => {
      for (let i = 0; i < orderedIds.length; i++) {
        await tx
          .update(menuItems)
          .set({ sortOrder: i, updatedAt: new Date() })
          .where(
            and(
              eq(menuItems.id, orderedIds[i]),
              eq(menuItems.restaurantId, restaurantId),
              eq(menuItems.categoryId, categoryId),
            ),
          );
      }
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
