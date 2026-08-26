import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { menuItems } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { reorderItemsSchema } from "@/lib/validation/menu";
import { hasValidCsrfHeader } from "@/lib/request";
import { rateLimit } from "@/lib/rate-limit";

export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.EDIT_MENU);

    // QA hardening (P2 backlog): menu writes were the one authenticated
    // mutation surface in this codebase with no rate-limit backstop at
    // all — every other write path (payments, gateway calls, the AI
    // assistant) already has one. Being authenticated + EDIT_MENU-gated
    // already rules out a random attacker; this only guards against a
    // buggy client retry loop or a compromised staff session hammering
    // writes. Generous on purpose — a busy admin reordering a whole menu
    // in one sitting must never be blocked by this.
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

    const parsed = await parseJsonBody(request, reorderItemsSchema);
    if (!parsed.ok) return parsed.response;
    const { categoryId, orderedIds } = parsed.data;

    const owned = await db
      .select({ id: menuItems.id })
      .from(menuItems)
      .where(and(eq(menuItems.restaurantId, restaurantId), eq(menuItems.categoryId, categoryId)));
    const ownedIds = new Set(owned.map((i) => i.id));
    if (!orderedIds.every((id) => ownedIds.has(id))) {
      return NextResponse.json(
        { error: "One or more items do not belong to this category/restaurant." },
        { status: 403 },
      );
    }

    await db.transaction(async (tx) => {
      for (let i = 0; i < orderedIds.length; i++) {
        await tx
          .update(menuItems)
          .set({ sortOrder: i, updatedAt: new Date() })
          .where(
            and(
              eq(menuItems.id, orderedIds[i]),
              eq(menuItems.restaurantId, restaurantId),
              eq(menuItems.categoryId, categoryId),
            ),
          );
      }
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
