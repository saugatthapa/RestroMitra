import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { menuVariants } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { updateVariantSchema } from "@/lib/validation/menu";
import { getOwnedMenuItem } from "@/lib/menu";
import { requirePermission } from "@/lib/rbac/guard";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { rateLimit } from "@/lib/rate-limit";

async function getOwnedVariant(itemId: string, variantId: string) {
  const rows = await db
    .select()
    .from(menuVariants)
    .where(and(eq(menuVariants.id, variantId), eq(menuVariants.menuItemId, itemId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ slug: string; itemId: string; variantId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, itemId, variantId } = await ctx.params;
    const { session, restaurantId, role } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.EDIT_MENU,
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
    if (!item) return NextResponse.json({ error: "Menu item not found." }, { status: 404 });
    const variant = await getOwnedVariant(itemId, variantId);
    if (!variant) return NextResponse.json({ error: "Variant not found." }, { status: 404 });

    const parsed = await parseJsonBody(request, updateVariantSchema);
    if (!parsed.ok) return parsed.response;
    if (Object.keys(parsed.data).length === 0) {
      return NextResponse.json({ error: "No changes provided." }, { status: 400 });
    }

    const { price, recipeQuantityMultiplierPercent, ...rest } = parsed.data;
    if (price !== undefined) {
      await requirePermission(session.user.id, restaurantId, PERMISSIONS.EDIT_PRICE, role);
    }
    // Gap-audit P1 fix (recipe costing) — this multiplier drives real
    // inventory deduction and COGS, the same sensitivity as recipeItems
    // (gated by MANAGE_INVENTORY on the recipe route), not a customer-
    // facing price change, so it's gated separately from EDIT_PRICE above.
    if (recipeQuantityMultiplierPercent !== undefined) {
      await requirePermission(session.user.id, restaurantId, PERMISSIONS.MANAGE_INVENTORY, role);
    }

    const [updated] = await db
      .update(menuVariants)
      .set({
        ...rest,
        ...(price !== undefined ? { priceInPaisa: price } : {}),
        ...(recipeQuantityMultiplierPercent !== undefined
          ? { recipeQuantityMultiplierBasisPoints: recipeQuantityMultiplierPercent }
          : {}),
      })
      .where(and(eq(menuVariants.id, variantId), eq(menuVariants.menuItemId, itemId)))
      .returning();

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "menu.variant.updated",
      resourceType: "menu_variant",
      resourceId: variantId,
      ipAddress: getClientIp(request),
      metadata: { menuItemId: itemId, fields: Object.keys(parsed.data) },
    });

    return NextResponse.json({ variant: updated });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ slug: string; itemId: string; variantId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, itemId, variantId } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.EDIT_MENU,
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
    if (!item) return NextResponse.json({ error: "Menu item not found." }, { status: 404 });
    const variant = await getOwnedVariant(itemId, variantId);
    if (!variant) return NextResponse.json({ error: "Variant not found." }, { status: 404 });

    const [updated] = await db
      .update(menuVariants)
      .set({ isActive: false })
      .where(and(eq(menuVariants.id, variantId), eq(menuVariants.menuItemId, itemId)))
      .returning();

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "menu.variant.deactivated",
      resourceType: "menu_variant",
      resourceId: variantId,
      ipAddress: getClientIp(request),
      metadata: { menuItemId: itemId },
    });

    return NextResponse.json({ variant: updated });
  } catch (err) {
    return toErrorResponse(err);
  }
}
