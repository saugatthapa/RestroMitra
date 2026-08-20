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

    const item = await getOwnedMenuItem(restaurantId, itemId);
    if (!item) return NextResponse.json({ error: "Menu item not found." }, { status: 404 });
    const variant = await getOwnedVariant(itemId, variantId);
    if (!variant) return NextResponse.json({ error: "Variant not found." }, { status: 404 });

    const parsed = await parseJsonBody(request, updateVariantSchema);
    if (!parsed.ok) return parsed.response;
    if (Object.keys(parsed.data).length === 0) {
      return NextResponse.json({ error: "No changes provided." }, { status: 400 });
    }

    const { price, ...rest } = parsed.data;
    if (price !== undefined) {
      await requirePermission(session.user.id, restaurantId, PERMISSIONS.EDIT_PRICE, role);
    }

    const [updated] = await db
      .update(menuVariants)
      .set({ ...rest, ...(price !== undefined ? { priceInPaisa: price } : {}) })
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
