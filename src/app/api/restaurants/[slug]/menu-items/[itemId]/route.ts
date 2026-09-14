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
import { rateLimit } from "@/lib/rate-limit";
import { recordTaxRateChange } from "@/lib/accounting/tax-rate-history";
import { restaurantDate } from "@/lib/restaurant-date";

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
    const { session, restaurantId, role, timezone } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.EDIT_MENU,
    );

    // QA hardening (P2 backlog): shared `menu-write:user` rate-limit
    // bucket across every menu mutation route — see
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
      await requirePermission(session.user.id, restaurantId, PERMISSIONS.EDIT_PRICE, role);
    }

    // Phase 6, Slice 6b — effectiveFrom only means anything alongside an
    // actual rate change, and "the future" can only be judged against
    // THIS restaurant's own timezone, not the schema's plain string check.
    const today = restaurantDate(timezone);
    let taxRateEffectiveFrom: string | undefined;
    if (data.taxRatePercent !== undefined) {
      taxRateEffectiveFrom = data.taxRateEffectiveFrom ?? today;
      if (taxRateEffectiveFrom > today) {
        return NextResponse.json(
          {
            error:
              "Tax rate changes can't be scheduled for a future date yet — enter the change on the day it takes effect.",
          },
          { status: 400 },
        );
      }
    } else if (data.taxRateEffectiveFrom !== undefined) {
      return NextResponse.json(
        { error: "taxRateEffectiveFrom requires taxRatePercent." },
        { status: 400 },
      );
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

    // Phase 6, Slice 6b — taxRatePercent/taxRateEffectiveFrom are pulled
    // out and handled by recordTaxRateChange, never written directly here:
    // that function is the only writer of menuItems.taxRateBasisPoints
    // (see its own comment), so this update's `rest` never includes it.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- pulled out of `rest` so it never reaches menuItems.set(); consumed above via the validated `taxRateEffectiveFrom` local instead.
    const { price, taxRatePercent, taxRateEffectiveFrom: _taxRateEffectiveFrom, ...rest } = data;
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(menuItems)
        .set({
          ...rest,
          description: data.description === undefined ? undefined : data.description || null,
          imageUrl: data.imageUrl === undefined ? undefined : data.imageUrl || null,
          sku: data.sku === undefined ? undefined : data.sku || null,
          ...(price !== undefined ? { basePriceInPaisa: price } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(menuItems.id, itemId), eq(menuItems.restaurantId, restaurantId)))
        .returning();

      if (taxRatePercent !== undefined && taxRateEffectiveFrom) {
        await recordTaxRateChange(tx, {
          restaurantId,
          menuItemId: itemId,
          taxRateBasisPoints: taxRatePercent,
          effectiveFrom: taxRateEffectiveFrom,
          asOfDate: today,
          createdByUserId: session.user.id,
        });
        // recordTaxRateChange may have resolved the live rate to a value
        // OTHER than taxRatePercent (a backdated correction that a later
        // change has since superseded — see that function's own comment),
        // so re-read rather than assume `row` already reflects it.
        const [refreshed] = await tx
          .select()
          .from(menuItems)
          .where(eq(menuItems.id, itemId))
          .limit(1);
        return refreshed ?? row;
      }

      return row;
    });

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

    // QA hardening (P2 backlog): shared `menu-write:user` rate-limit
    // bucket across every menu mutation route — see
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
