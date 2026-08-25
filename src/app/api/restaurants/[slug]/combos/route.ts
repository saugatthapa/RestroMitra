import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { menuCombos, menuComboItems } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { createComboSchema, resolveComboPriceInPaisa } from "@/lib/validation/combos";
import { assertComboItemsOwnership } from "@/lib/combos";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Commercial Launch Phase B.8 — Combos. Gated EDIT_MENU, same trust tier as
 * menu items — a combo is a menu-builder concept, not a checkout-time
 * discretion (that's Coupons/manual discounts under APPLY_DISCOUNT).
 */
export async function GET(_request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug);

    const combos = await db.query.menuCombos.findMany({
      where: eq(menuCombos.restaurantId, restaurantId),
      orderBy: [asc(menuCombos.createdAt)],
      with: { items: true },
    });

    return NextResponse.json({ combos });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.EDIT_MENU);

    const parsed = await parseJsonBody(request, createComboSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    await assertComboItemsOwnership(restaurantId, data.items);

    const result = await db.transaction(async (tx) => {
      const [combo] = await tx
        .insert(menuCombos)
        .values({
          restaurantId,
          name: data.name,
          description: data.description || null,
          priceInPaisa: resolveComboPriceInPaisa(data.price),
        })
        .returning();

      const items = await tx
        .insert(menuComboItems)
        .values(
          data.items.map((item) => ({
            comboId: combo.id,
            menuItemId: item.menuItemId,
            variantId: item.variantId ?? null,
            quantity: item.quantity,
          })),
        )
        .returning();

      return { combo, items };
    });

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "combo.created",
      resourceType: "menu_combo",
      resourceId: result.combo.id,
      ipAddress: getClientIp(request),
      metadata: { name: result.combo.name, priceInPaisa: result.combo.priceInPaisa, itemCount: result.items.length },
    });

    return NextResponse.json({ combo: { ...result.combo, items: result.items } }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
