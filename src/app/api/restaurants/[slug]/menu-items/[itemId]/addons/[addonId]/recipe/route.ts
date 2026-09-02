import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { inventoryItems, menuAddons, addonRecipeItems } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { replaceAddonRecipeSchema } from "@/lib/validation/inventory";
import { getOwnedMenuItem } from "@/lib/menu";
import { hasPermission } from "@/lib/rbac/guard";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { rateLimit } from "@/lib/rate-limit";

async function getOwnedAddon(itemId: string, addonId: string) {
  const rows = await db
    .select({ id: menuAddons.id, name: menuAddons.name })
    .from(menuAddons)
    .where(and(eq(menuAddons.id, addonId), eq(menuAddons.menuItemId, itemId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Gap-audit P1 fix (recipe costing) — an add-on's own bill-of-ingredients,
 * mirroring the menu-item recipe route (../../recipe/route.ts) exactly:
 * same GET/PUT shape, same MANAGE_INVENTORY/VIEW_PROFIT permission split,
 * same full-replace semantics. Kept as its own table/route rather than
 * reusing recipeItems (keyed by menuItemId) because an add-on isn't a
 * menu item — "Extra cheese" has no row in menuItems to hang a recipe off
 * of, and folding add-on ingredients into recipeItems would make every
 * COGS query that joins recipeItems on menuItemId either double-count or
 * need to filter add-on rows back out. See addonRecipeItems' own schema
 * comment for the full reasoning.
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ slug: string; itemId: string; addonId: string }> },
) {
  try {
    const { slug, itemId, addonId } = await ctx.params;
    const { session, restaurantId, role } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_INVENTORY,
    );

    const item = await getOwnedMenuItem(restaurantId, itemId);
    if (!item) {
      return NextResponse.json({ error: "Menu item not found." }, { status: 404 });
    }
    const addon = await getOwnedAddon(itemId, addonId);
    if (!addon) {
      return NextResponse.json({ error: "Add-on not found." }, { status: 404 });
    }

    const rows = await db.query.addonRecipeItems.findMany({
      where: eq(addonRecipeItems.addonId, addonId),
      with: { inventoryItem: true },
    });

    const canViewProfit = await hasPermission(session.user.id, restaurantId, PERMISSIONS.VIEW_PROFIT, role);

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

    const response: Record<string, unknown> = { addonId, items };
    if (canViewProfit) {
      response.costPerSelectionInPaisa = items.reduce(
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
 * Full replace, not incremental add/remove — same convention as the
 * menu-item recipe route's PUT handler for the same reasons (short,
 * infrequently-edited list; a piecemeal add/update/delete API buys
 * nothing here).
 */
export async function PUT(
  request: Request,
  ctx: { params: Promise<{ slug: string; itemId: string; addonId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, itemId, addonId } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_INVENTORY,
    );

    // QA hardening (P2 backlog): shared `menu-write:user` rate-limit
    // bucket across every menu-item-scoped mutation route — see
    // menu-items/reorder/route.ts's comment for the full rationale.
    const limit = await rateLimit(`menu-write:user:${session.user.id}`, {
      limit: 60,
      windowMs: 5 * 60 * 1000,
    });
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "Too many menu changes in a short time. Please wait a few minutes and try again." },
        { status: 429 },
      );
    }

    const item = await getOwnedMenuItem(restaurantId, itemId);
    if (!item) {
      return NextResponse.json({ error: "Menu item not found." }, { status: 404 });
    }
    const addon = await getOwnedAddon(itemId, addonId);
    if (!addon) {
      return NextResponse.json({ error: "Add-on not found." }, { status: 404 });
    }

    const parsed = await parseJsonBody(request, replaceAddonRecipeSchema);
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
      await tx.delete(addonRecipeItems).where(eq(addonRecipeItems.addonId, addonId));

      if (data.items.length === 0) return [];

      return tx
        .insert(addonRecipeItems)
        .values(
          data.items.map((line) => ({
            restaurantId,
            addonId,
            inventoryItemId: line.inventoryItemId,
            quantityPerServingMilliunits: line.quantityPerServing,
          })),
        )
        .returning();
    });

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "inventory.addon_recipe.replaced",
      resourceType: "menu_addon",
      resourceId: addonId,
      ipAddress: getClientIp(request),
      metadata: { menuItemId: itemId, ingredientCount: inserted.length },
    });

    return NextResponse.json({ addonId, items: inserted });
  } catch (err) {
    return toErrorResponse(err);
  }
}
