import { NextResponse } from "next/server";
import { eq, count } from "drizzle-orm";
import { db } from "@/db";
import { menuVariants } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { createVariantSchema } from "@/lib/validation/menu";
import { getOwnedMenuItem } from "@/lib/menu";
import { requirePermission } from "@/lib/rbac/guard";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { rateLimit } from "@/lib/rate-limit";

export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string; itemId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, itemId } = await ctx.params;
    // Creating a variant sets its price, so this needs both edit_menu
    // (adding a menu structure element) and edit_price (it has a price).
    const { session, restaurantId, role } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.EDIT_MENU,
    );
    await requirePermission(session.user.id, restaurantId, PERMISSIONS.EDIT_PRICE, role);

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

    const parsed = await parseJsonBody(request, createVariantSchema);
    if (!parsed.ok) return parsed.response;

    const [{ total }] = await db
      .select({ total: count() })
      .from(menuVariants)
      .where(eq(menuVariants.menuItemId, itemId));

    const [variant] = await db
      .insert(menuVariants)
      .values({
        menuItemId: itemId,
        name: parsed.data.name,
        priceInPaisa: parsed.data.price,
        sortOrder: total,
      })
      .returning();

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "menu.variant.created",
      resourceType: "menu_variant",
      resourceId: variant.id,
      ipAddress: getClientIp(request),
      metadata: { menuItemId: itemId, name: variant.name, priceInPaisa: variant.priceInPaisa },
    });

    return NextResponse.json({ variant }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
