import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { menuItems, categories } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import {
  resolveRestaurantContext,
  parseJsonBody,
  toErrorResponse,
} from "@/lib/api-route-helpers";
import { updateMenuItemSchema } from "@/lib/validation/menu";
import { requirePermission } from "@/lib/rbac/guard";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

async function getOwnedItem(restaurantId: string, itemId: string) {
  const rows = await db
    .select()
    .from(menuItems)
    .where(and(eq(menuItems.id, itemId), eq(menuItems.restaurantId, restaurantId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ slug: string; itemId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, itemId } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.EDIT_MENU,
    );

    const existing = await getOwnedItem(restaurantId, itemId);
    if (!existing) {
      return NextResponse.json({ error: "Menu item not found." }, { status: 404 });
    }

    const parsed = await parseJsonBody(request, updateMenuItemSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    // Price changes require the separate edit_price permission, even for
    // someone who already has edit_menu (e.g. a manager, per the default
    // role matrix, can restructure the menu but not change prices).
    if (data.price !== undefined) {
      await requirePermission(session.user.id, restaurantId, PERMISSIONS.EDIT_PRICE);
    }

    if (data.categoryId) {
      const categoryOwned = await db
        .select({ id: categories.id })
        .from(categories)
        .where(
          and(eq(categories.id, data.categoryId), eq(categories.restaurantId, restaurantId)),
        )
        .limit(1);
      if (categoryOwned.length === 0) {
        return NextResponse.json({ error: "Category not found." }, { status: 404 });
      }
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: "No changes provided." }, { status: 400 });
    }

    const { price, taxRatePercent, ...rest } = data;
    const [updated] = await db
      .update(menuItems)
      .set({
        ...rest,
        description: data.description === undefined ? undefined : data.description || null,
        imageUrl: data.imageUrl === undefined ? undefined : data.imageUrl || null,
        sku: data.sku === undefined ? undefined : data.sku || null,
        ...(price !== undefined ? { basePriceInPaisa: price } : {}),
        ...(taxRatePercent !== undefined ? { taxRateBasisPoints: taxRatePercent } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(menuItems.id, itemId), eq(menuItems.restaurantId, restaurantId)))
      .returning();

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "menu.item.updated",
      resourceType: "menu_item",
      resourceId: itemId,
      ipAddress: getClientIp(request),
      metadata: { fields: Object.keys(data) },
    });

    return NextResponse.json({ menuItem: updated });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ slug: string; itemId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, itemId } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.EDIT_MENU,
    );

    const existing = await getOwnedItem(restaurantId, itemId);
    if (!existing) {
      return NextResponse.json({ error: "Menu item not found." }, { status: 404 });
    }

    // Soft delete (deactivate), consistent with categories — see that
    // route's comment for why we don't hard-delete menu items.
    const [updated] = await db
      .update(menuItems)
      .set({ isActive: false, isAvailable: false, updatedAt: new Date() })
      .where(and(eq(menuItems.id, itemId), eq(menuItems.restaurantId, restaurantId)))
      .returning();

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "menu.item.deactivated",
      resourceType: "menu_item",
      resourceId: itemId,
      ipAddress: getClientIp(request),
    });

    return NextResponse.json({ menuItem: updated });
  } catch (err) {
    return toErrorResponse(err);
  }
}
