import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { categories } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { reorderSchema } from "@/lib/validation/menu";
import { hasValidCsrfHeader } from "@/lib/request";

export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.EDIT_MENU);

    const parsed = await parseJsonBody(request, reorderSchema);
    if (!parsed.ok) return parsed.response;

    // Verify every id in the reorder request actually belongs to this
    // restaurant BEFORE writing anything — otherwise a caller could pass
    // another tenant's category id and this restaurant's owner could
    // (at best) probe for existence, or worse, overwrite its sort order.
    const owned = await db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.restaurantId, restaurantId));
    const ownedIds = new Set(owned.map((c) => c.id));
    const allOwned = parsed.data.orderedIds.every((id) => ownedIds.has(id));
    if (!allOwned) {
      return NextResponse.json(
        { error: "One or more categories do not belong to this restaurant." },
        { status: 403 },
      );
    }

    await db.transaction(async (tx) => {
      for (let i = 0; i < parsed.data.orderedIds.length; i++) {
        await tx
          .update(categories)
          .set({ sortOrder: i, updatedAt: new Date() })
          .where(
            and(
              eq(categories.id, parsed.data.orderedIds[i]),
              eq(categories.restaurantId, restaurantId),
            ),
          );
      }
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
