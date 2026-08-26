import { NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { menuItems, categories } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { createMenuItemSchema } from "@/lib/validation/menu";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { rateLimit } from "@/lib/rate-limit";

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug);

    const items = await db.query.menuItems.findMany({
      where: eq(menuItems.restaurantId, restaurantId),
      orderBy: [asc(menuItems.sortOrder), asc(menuItems.createdAt)],
      with: {
        variants: { orderBy: (v, { asc }) => [asc(v.sortOrder)] },
        addons: { orderBy: (a, { asc }) => [asc(a.sortOrder)] },
      },
    });

    return NextResponse.json({ menuItems: items });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.EDIT_MENU,
    );

    // QA hardening (P2 backlog): menu writes had no rate-limit backstop at
    // all — see reorder/route.ts's own comment for the full rationale.
    // Shares the same `menu-write:user` bucket as every other menu
    // mutation route, since they're all the same abuse surface.
    const limit = rateLimit(`menu-write:user:${session.user.id}`, {
      limit: 60,
      windowMs: 5 * 60 * 1000,
    });
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "Too many menu changes in a short time. Please wait a few minutes and try again." },
        { status: 429 },
      );
    }

    const parsed = await parseJsonBody(request, createMenuItemSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    // Verify the category actually belongs to THIS restaurant — a
    // category id from another tenant must never be accepted, even
    // though the FK alone would still block cross-tenant *insertion*
    // (it would just fail with a DB error instead of a clean 404).
    const categoryOwned = await db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.id, data.categoryId), eq(categories.restaurantId, restaurantId)))
      .limit(1);
    if (categoryOwned.length === 0) {
      return NextResponse.json({ error: "Category not found." }, { status: 404 });
    }

    const [item] = await db
      .insert(menuItems)
      .values({
        restaurantId,
        categoryId: data.categoryId,
        kitchenStationId: data.kitchenStationId ?? null,
        name: data.name,
        description: data.description || null,
        imageUrl: data.imageUrl || null,
        sku: data.sku || null,
        basePriceInPaisa: data.price,
        taxRateBasisPoints: data.taxRatePercent ?? 0,
        prepTimeMinutes: data.prepTimeMinutes ?? null,
        isAvailable: data.isAvailable ?? true,
      })
      .returning();

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "menu.item.created",
      resourceType: "menu_item",
      resourceId: item.id,
      ipAddress: getClientIp(request),
      metadata: { name: item.name, priceInPaisa: item.basePriceInPaisa },
    });

    return NextResponse.json({ menuItem: item }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
