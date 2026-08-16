import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { inventoryItems, menuItems, recipeItems } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { replaceRecipeSchema } from "@/lib/validation/inventory";
import { hasPermission } from "@/lib/rbac/guard";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

async function getOwnedMenuItem(restaurantId: string, itemId: string) {
  const rows = await db
    .select({ id: menuItems.id, name: menuItems.name })
    .from(menuItems)
    .where(and(eq(menuItems.id, itemId), eq(menuItems.restaurantId, restaurantId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * A menu item's recipe (bill of ingredients) is read through the recipe
 * route, gated by MANAGE_INVENTORY like the rest of inventory — recipes
 * are the join between the menu and stock, so they carry the same
 * sensitivity as inventory itself. Cost fields (costPerServingInPaisa,
 * per-line lineCostInPaisa) are only included when the caller additionally
 * holds VIEW_PROFIT — a check made with the non-throwing hasPermission()
 * helper rather than rejecting the whole request, since the ingredient
 * *list* itself (useful for e.g. allergen/86'd-ingredient displays) is
 * still meaningful without cost data. In the current default role matrix
 * every role with MANAGE_INVENTORY also has VIEW_PROFIT, so this split has
 * no visible effect yet — it's forward-looking for custom role
 * permissions.
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ slug: string; itemId: string }> },
) {
  try {
    const { slug, itemId } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_INVENTORY,
    );

    const menuItem = await getOwnedMenuItem(restaurantId, itemId);
    if (!menuItem) {
      return NextResponse.json({ error: "Menu item not found." }, { status: 404 });
    }

    const rows = await db.query.recipeItems.findMany({
      where: eq(recipeItems.menuItemId, itemId),
      with: { inventoryItem: true },
    });

    const canViewProfit = await hasPermission(session.user.id, restaurantId, PERMISSIONS.VIEW_PROFIT);

    const items = rows.map((line) => ({
      id: line.id,
      inventoryItemId: line.inventoryItemId,
      inventoryItemName: line.inventoryItem.name,
      unit: line.inventoryItem.unit,
      quantityPerServingMilliunits: line.quantityPerServingMilliunits,
      ...(canViewProfit
        ? {
            lineCostInPaisa: Math.round(
              (line.quantityPerServingMilliunits / 1000) * line.inventoryItem.costPerUnitInPaisa,
            ),
          }
        : {}),
    }));

    const response: Record<string, unknown> = { menuItemId: itemId, items };
    if (canViewProfit) {
      response.costPerServingInPaisa = items.reduce(
        (sum, i) => sum + (("lineCostInPaisa" in i ? i.lineCostInPaisa : 0) as number),
        0,
      );
    }

    return NextResponse.json(response);
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Full replace, not incremental add/remove — the client always sends the
 * complete desired ingredient list, and this route diffs it against the
 * DB inside one transaction (delete all existing lines for this menu item,
 * insert the new set). Simpler and less error-prone than a piecemeal
 * add/update/delete API for what's normally a short, infrequently-edited
 * list (a handful of ingredients per dish).
 */
export async function PUT(
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
      PERMISSIONS.MANAGE_INVENTORY,
    );

    const menuItem = await getOwnedMenuItem(restaurantId, itemId);
    if (!menuItem) {
      return NextResponse.json({ error: "Menu item not found." }, { status: 404 });
    }

    const parsed = await parseJsonBody(request, replaceRecipeSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    if (data.items.length > 0) {
      const ownedItemIds = new Set(
        (
          await db
            .select({ id: inventoryItems.id })
            .from(inventoryItems)
            .where(eq(inventoryItems.restaurantId, restaurantId))
        ).map((r) => r.id),
      );
      for (const line of data.items) {
        if (!ownedItemIds.has(line.inventoryItemId)) {
          return NextResponse.json({ error: "Inventory item not found." }, { status: 404 });
        }
      }
    }

    const inserted = await db.transaction(async (tx) => {
      await tx.delete(recipeItems).where(eq(recipeItems.menuItemId, itemId));

      if (data.items.length === 0) return [];

      return tx
        .insert(recipeItems)
        .values(
          data.items.map((line) => ({
            restaurantId,
            menuItemId: itemId,
            inventoryItemId: line.inventoryItemId,
            quantityPerServingMilliunits: line.quantityPerServing,
          })),
        )
        .returning();
    });

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "inventory.recipe.replaced",
      resourceType: "menu_item",
      resourceId: itemId,
      ipAddress: getClientIp(request),
      metadata: { ingredientCount: inserted.length },
    });

    return NextResponse.json({ menuItemId: itemId, items: inserted });
  } catch (err) {
    return toErrorResponse(err);
  }
}
