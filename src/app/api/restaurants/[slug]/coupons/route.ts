import { NextResponse } from "next/server";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { coupons, couponBranches, couponMenuItems, couponCategories } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { createCouponSchema, resolveCreateCouponInput } from "@/lib/validation/coupons";
import { CouponError, normalizeCouponCode, assertCouponRestrictionsOwnership } from "@/lib/coupons";
import { isUniqueViolation } from "@/lib/db-error";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Commercial Launch Phase B.6 — Coupons. Gated on APPLY_DISCOUNT for both
 * defining AND redeeming coupons — same trust tier as a manual discount
 * (manager/owner by default): a reusable code is just another way to grant
 * a discount, so whoever's trusted to comp a bill by hand is trusted to
 * define a code that does the same thing.
 */
export async function GET(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.APPLY_DISCOUNT);

    const rows = await db
      .select()
      .from(coupons)
      .where(eq(coupons.restaurantId, restaurantId))
      .orderBy(desc(coupons.createdAt));

    // Restriction rows fetched restaurant-wide (not per-coupon N+1) and
    // grouped in memory — a restaurant realistically has a handful of
    // coupons, each with a handful of restriction rows at most.
    const couponIds = rows.map((c) => c.id);
    const [branchRows, menuItemRows, categoryRows] =
      couponIds.length === 0
        ? [[], [], []]
        : await Promise.all([
            db.select().from(couponBranches).where(inArray(couponBranches.couponId, couponIds)),
            db.select().from(couponMenuItems).where(inArray(couponMenuItems.couponId, couponIds)),
            db.select().from(couponCategories).where(inArray(couponCategories.couponId, couponIds)),
          ]);

    const withRestrictions = rows.map((coupon) => ({
      ...coupon,
      branchIds: branchRows.filter((r) => r.couponId === coupon.id).map((r) => r.branchId),
      menuItemIds: menuItemRows.filter((r) => r.couponId === coupon.id).map((r) => r.menuItemId),
      categoryIds: categoryRows.filter((r) => r.couponId === coupon.id).map((r) => r.categoryId),
    }));

    return NextResponse.json({ coupons: withRestrictions });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.APPLY_DISCOUNT);

    const parsed = await parseJsonBody(request, createCouponSchema);
    if (!parsed.ok) return parsed.response;
    const resolved = resolveCreateCouponInput(parsed.data);
    const code = normalizeCouponCode(parsed.data.code);

    await assertCouponRestrictionsOwnership(restaurantId, {
      branchIds: resolved.branchIds,
      menuItemIds: resolved.menuItemIds,
      categoryIds: resolved.categoryIds,
    });

    const result = await db.transaction(async (tx) => {
      const [coupon] = await tx
        .insert(coupons)
        .values({
          restaurantId,
          code,
          discountType: resolved.discountType,
          discountValue: resolved.discountValue,
          maxDiscountInPaisa: resolved.maxDiscountInPaisa,
          minOrderSubtotalInPaisa: resolved.minOrderSubtotalInPaisa,
          usageLimit: resolved.usageLimit,
          perCustomerLimit: resolved.perCustomerLimit,
          firstOrderOnly: resolved.firstOrderOnly,
          startsAt: resolved.startsAt,
          expiresAt: resolved.expiresAt,
          note: resolved.note,
          createdByUserId: session.user.id,
        })
        .returning()
        .catch((err) => {
          // Unique index (restaurantId, code) — surface a clean 409 rather
          // than a raw Postgres constraint error.
          if (isUniqueViolation(err)) {
            throw new CouponError("A coupon with this code already exists.", 409);
          }
          throw err;
        });

      if (resolved.branchIds.length > 0) {
        await tx
          .insert(couponBranches)
          .values(resolved.branchIds.map((branchId) => ({ restaurantId, couponId: coupon.id, branchId })));
      }
      if (resolved.menuItemIds.length > 0) {
        await tx
          .insert(couponMenuItems)
          .values(resolved.menuItemIds.map((menuItemId) => ({ restaurantId, couponId: coupon.id, menuItemId })));
      }
      if (resolved.categoryIds.length > 0) {
        await tx
          .insert(couponCategories)
          .values(resolved.categoryIds.map((categoryId) => ({ restaurantId, couponId: coupon.id, categoryId })));
      }

      return coupon;
    });
    const coupon = result;

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "coupon.created",
      resourceType: "coupon",
      resourceId: coupon.id,
      ipAddress: getClientIp(request),
      metadata: { code: coupon.code, discountType: coupon.discountType, discountValue: coupon.discountValue },
    });

    return NextResponse.json(
      {
        coupon: {
          ...coupon,
          branchIds: resolved.branchIds,
          menuItemIds: resolved.menuItemIds,
          categoryIds: resolved.categoryIds,
        },
      },
      { status: 201 },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
