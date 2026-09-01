import { NextResponse } from "next/server";
import { eq, count } from "drizzle-orm";
import { db } from "@/db";
import { menuAddons } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { createAddonSchema } from "@/lib/validation/menu";
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

    const parsed = await parseJsonBody(request, createAddonSchema);
    if (!parsed.ok) return parsed.response;

    if (parsed.data.price > 0) {
      await requirePermission(session.user.id, restaurantId, PERMISSIONS.EDIT_PRICE, role);
    }

    const [{ total }] = await db
      .select({ total: count() })
      .from(menuAddons)
      .where(eq(menuAddons.menuItemId, itemId));

    const [addon] = await db
      .insert(menuAddons)
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
      action: "menu.addon.created",
      resourceType: "menu_addon",
      resourceId: addon.id,
      ipAddress: getClientIp(request),
      metadata: { menuItemId: itemId, name: addon.name, priceInPaisa: addon.priceInPaisa },
    });

    return NextResponse.json({ addon }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
