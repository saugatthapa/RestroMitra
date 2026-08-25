import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { menuCombos, menuComboItems } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { updateComboSchema, resolveComboPriceInPaisa } from "@/lib/validation/combos";
import { assertComboItemsOwnership } from "@/lib/combos";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/** Edits a combo's name/price/items, or toggles isActive. See updateComboSchema's own comment for the whole-state-replace semantics of `items`. Gated EDIT_MENU, same as combos/route.ts. */
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ slug: string; comboId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, comboId } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.EDIT_MENU);

    const existing = await db
      .select({ id: menuCombos.id })
      .from(menuCombos)
      .where(and(eq(menuCombos.id, comboId), eq(menuCombos.restaurantId, restaurantId)))
      .limit(1);
    if (existing.length === 0) {
      return NextResponse.json({ error: "Combo not found." }, { status: 404 });
    }

    const parsed = await parseJsonBody(request, updateComboSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    if (data.items) {
      await assertComboItemsOwnership(restaurantId, data.items);
    }

    const result = await db.transaction(async (tx) => {
      const [combo] = await tx
        .update(menuCombos)
        .set({
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.description !== undefined ? { description: data.description?.trim() || null } : {}),
          ...(data.price !== undefined ? { priceInPaisa: resolveComboPriceInPaisa(data.price) } : {}),
          ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(menuCombos.id, comboId), eq(menuCombos.restaurantId, restaurantId)))
        .returning();

      let items = await tx.select().from(menuComboItems).where(eq(menuComboItems.comboId, comboId));
      if (data.items) {
        await tx.delete(menuComboItems).where(eq(menuComboItems.comboId, comboId));
        items = await tx
          .insert(menuComboItems)
          .values(
            data.items.map((item) => ({
              comboId,
              menuItemId: item.menuItemId,
              variantId: item.variantId ?? null,
              quantity: item.quantity,
            })),
          )
          .returning();
      }

      return { combo, items };
    });

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "combo.updated",
      resourceType: "menu_combo",
      resourceId: comboId,
      ipAddress: getClientIp(request),
      metadata: { changes: { ...data, items: data.items ? data.items.length : undefined } },
    });

    return NextResponse.json({ combo: { ...result.combo, items: result.items } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
