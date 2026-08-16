import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { categories, menuItems } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { updateCategorySchema } from "@/lib/validation/menu";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

async function getOwnedCategory(restaurantId: string, categoryId: string) {
  const rows = await db
    .select()
    .from(categories)
    .where(and(eq(categories.id, categoryId), eq(categories.restaurantId, restaurantId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ slug: string; categoryId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, categoryId } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.EDIT_MENU,
    );

    const existing = await getOwnedCategory(restaurantId, categoryId);
    if (!existing) {
      return NextResponse.json({ error: "Category not found." }, { status: 404 });
    }

    const parsed = await parseJsonBody(request, updateCategorySchema);
    if (!parsed.ok) return parsed.response;
    if (Object.keys(parsed.data).length === 0) {
      return NextResponse.json({ error: "No changes provided." }, { status: 400 });
    }

    const [updated] = await db
      .update(categories)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(and(eq(categories.id, categoryId), eq(categories.restaurantId, restaurantId)))
      .returning();

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "menu.category.updated",
      resourceType: "category",
      resourceId: categoryId,
      ipAddress: getClientIp(request),
      metadata: parsed.data,
    });

    return NextResponse.json({ category: updated });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ slug: string; categoryId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, categoryId } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.EDIT_MENU,
    );

    const existing = await getOwnedCategory(restaurantId, categoryId);
    if (!existing) {
      return NextResponse.json({ error: "Category not found." }, { status: 404 });
    }

    // Soft delete: deactivate rather than hard-delete, so historical
    // orders/reports referencing menu items in this category (once orders
    // exist, in a later phase) keep resolving. Items already restrict
    // deletion of a category out from under them at the DB level too.
    const [updated] = await db
      .update(categories)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(categories.id, categoryId), eq(categories.restaurantId, restaurantId)))
      .returning();

    // Also deactivate items in this category so they stop showing up as
    // orderable, rather than leaving them active-but-orphaned in the UI.
    await db
      .update(menuItems)
      .set({ isActive: false, isAvailable: false, updatedAt: new Date() })
      .where(and(eq(menuItems.categoryId, categoryId), eq(menuItems.restaurantId, restaurantId)));

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "menu.category.deactivated",
      resourceType: "category",
      resourceId: categoryId,
      ipAddress: getClientIp(request),
    });

    return NextResponse.json({ category: updated });
  } catch (err) {
    return toErrorResponse(err);
  }
}
