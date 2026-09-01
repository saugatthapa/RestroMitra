import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { coupons, couponBranches, couponMenuItems, couponCategories } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { updateCouponSchema } from "@/lib/validation/coupons";
import { assertCouponRestrictionsOwnership } from "@/lib/coupons";
import { rupeesToPaisa } from "@/lib/money";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/** Edits a coupon's rules, or toggles isActive — see updateCouponSchema for what's editable and why. Gated APPLY_DISCOUNT, same as coupons/route.ts. */
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ slug: string; couponId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, couponId } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.APPLY_DISCOUNT);

    const existing = await db
      .select({ id: coupons.id, discountType: coupons.discountType })
      .from(coupons)
      .where(and(eq(coupons.id, couponId), eq(coupons.restaurantId, restaurantId)))
      .limit(1);
    if (existing.length === 0) {
      return NextResponse.json({ error: "Coupon not found." }, { status: 404 });
    }

    const parsed = await parseJsonBody(request, updateCouponSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    // The coupon's discountValue is only meaningful in light of its type
    // (paisa for flat, basis-points-of-a-percent for percentage — see
    // resolveCreateCouponInput). Figure out what type will be in effect
    // after this update (either just-changed, or the existing one), and
    // reject a discountPercent/discountFlatAmount that doesn't match it —
    // otherwise e.g. sending discountFlatAmount against a coupon that's
    // (and stays) "percentage" would silently store a paisa amount into a
    // column resolveCoupon later reads as basis points.
    const effectiveType = data.discountType ?? existing[0].discountType;
    if (effectiveType === "percentage" && data.discountFlatAmount !== undefined) {
      return NextResponse.json(
        { error: "This coupon is percentage-based — set discountPercent, not discountFlatAmount." },
        { status: 400 },
      );
    }
    if (effectiveType === "flat" && data.discountPercent !== undefined) {
      return NextResponse.json(
        { error: "This coupon is a flat amount — set discountFlatAmount, not discountPercent." },
        { status: 400 },
      );
    }

    if (data.branchIds || data.menuItemIds || data.categoryIds) {
      await assertCouponRestrictionsOwnership(restaurantId, {
        branchIds: data.branchIds,
        menuItemIds: data.menuItemIds,
        categoryIds: data.categoryIds,
      });
    }

    const result = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(coupons)
        .set({
          ...(data.discountType !== undefined ? { discountType: data.discountType } : {}),
          ...(data.discountPercent !== undefined
            ? { discountValue: Math.round(data.discountPercent * 100) }
            : {}),
          ...(data.discountFlatAmount !== undefined
            ? { discountValue: rupeesToPaisa(data.discountFlatAmount) }
            : {}),
          ...(data.maxDiscount !== undefined
            ? { maxDiscountInPaisa: data.maxDiscount === null ? null : rupeesToPaisa(data.maxDiscount) }
            : {}),
          ...(data.minOrderSubtotal !== undefined
            ? {
                minOrderSubtotalInPaisa:
                  data.minOrderSubtotal === null ? null : rupeesToPaisa(data.minOrderSubtotal),
              }
            : {}),
          ...(data.usageLimit !== undefined ? { usageLimit: data.usageLimit } : {}),
          ...(data.perCustomerLimit !== undefined ? { perCustomerLimit: data.perCustomerLimit } : {}),
          ...(data.firstOrderOnly !== undefined ? { firstOrderOnly: data.firstOrderOnly } : {}),
          ...(data.startsAt !== undefined ? { startsAt: data.startsAt ? new Date(data.startsAt) : null } : {}),
          ...(data.expiresAt !== undefined ? { expiresAt: data.expiresAt ? new Date(data.expiresAt) : null } : {}),
          ...(data.note !== undefined ? { note: data.note?.trim() || null } : {}),
          ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(coupons.id, couponId), eq(coupons.restaurantId, restaurantId)))
        .returning();

      // Whole-state-replace, same convention as combos/[comboId]/route.ts's
      // `items` handling — see updateCouponSchema's own comment. Only
      // touched (re-fetched only when NOT replaced) when the field is
      // actually present in the request.
      let branchIds = data.branchIds;
      if (branchIds !== undefined) {
        await tx.delete(couponBranches).where(eq(couponBranches.couponId, couponId));
        if (branchIds.length > 0) {
          await tx.insert(couponBranches).values(branchIds.map((branchId) => ({ restaurantId, couponId, branchId })));
        }
      } else {
        branchIds = (
          await tx.select({ branchId: couponBranches.branchId }).from(couponBranches).where(eq(couponBranches.couponId, couponId))
        ).map((r) => r.branchId);
      }

      let menuItemIds = data.menuItemIds;
      if (menuItemIds !== undefined) {
        await tx.delete(couponMenuItems).where(eq(couponMenuItems.couponId, couponId));
        if (menuItemIds.length > 0) {
          await tx
            .insert(couponMenuItems)
            .values(menuItemIds.map((menuItemId) => ({ restaurantId, couponId, menuItemId })));
        }
      } else {
        menuItemIds = (
          await tx.select({ menuItemId: couponMenuItems.menuItemId }).from(couponMenuItems).where(eq(couponMenuItems.couponId, couponId))
        ).map((r) => r.menuItemId);
      }

      let categoryIds = data.categoryIds;
      if (categoryIds !== undefined) {
        await tx.delete(couponCategories).where(eq(couponCategories.couponId, couponId));
        if (categoryIds.length > 0) {
          await tx
            .insert(couponCategories)
            .values(categoryIds.map((categoryId) => ({ restaurantId, couponId, categoryId })));
        }
      } else {
        categoryIds = (
          await tx.select({ categoryId: couponCategories.categoryId }).from(couponCategories).where(eq(couponCategories.couponId, couponId))
        ).map((r) => r.categoryId);
      }

      return { updated, branchIds, menuItemIds, categoryIds };
    });

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "coupon.updated",
      resourceType: "coupon",
      resourceId: couponId,
      ipAddress: getClientIp(request),
      metadata: { changes: data },
    });

    return NextResponse.json({
      coupon: {
        ...result.updated,
        branchIds: result.branchIds,
        menuItemIds: result.menuItemIds,
        categoryIds: result.categoryIds,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
