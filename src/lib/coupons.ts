import "server-only";
import { and, eq, gt, gte, isNull, or, sql } from "drizzle-orm";
import { db, type Transaction } from "@/db";
import { coupons, couponRedemptions } from "@/db/schema";
import { HttpError } from "@/lib/http-error";
import { computeDiscountInPaisa } from "@/lib/order-adjustments";

/**
 * Commercial Launch Phase B.6 — Coupons. A reusable, staff-defined promo
 * code that resolves into orders' existing discountType/discountValue slot
 * (see the coupons table's own comment in schema.ts) — this module is
 * deliberately thin: resolveCoupon reuses computeDiscountInPaisa from
 * order-adjustments.ts unchanged rather than a parallel pricing formula,
 * only adding the two things that are genuinely coupon-specific: eligibility
 * checks (active/dated/min-order/usage-limit) and the maxDiscountInPaisa cap
 * a manual discount has no equivalent for.
 */
export class CouponError extends HttpError {
  constructor(message: string, status = 400) {
    super(message, status);
  }
}

/** Coupons are always looked up by their upper-cased code — this is the one place that normalization happens. */
export function normalizeCouponCode(raw: string): string {
  return raw.trim().toUpperCase();
}

export type ResolvedCoupon = {
  coupon: typeof coupons.$inferSelect;
  discountInPaisa: number;
};

/**
 * Looks up a coupon by code and checks every eligibility rule EXCEPT the
 * usage-limit race itself (that's enforced atomically by redeemCoupon's own
 * compare-and-swap at the moment of actual redemption — this check here is
 * just a friendly early rejection, not the source of truth). Returns the
 * coupon plus the discount it resolves to for THIS subtotal (already
 * clamped by maxDiscountInPaisa for a percentage coupon).
 */
export async function resolveCoupon(
  restaurantId: string,
  rawCode: string,
  subtotalInPaisa: number,
  now: Date = new Date(),
): Promise<ResolvedCoupon> {
  const code = normalizeCouponCode(rawCode);
  if (!code) {
    throw new CouponError("Enter a coupon code.");
  }

  const [coupon] = await db
    .select()
    .from(coupons)
    .where(
      and(
        eq(coupons.restaurantId, restaurantId),
        eq(coupons.code, code),
        eq(coupons.isActive, true),
      ),
    )
    .limit(1);

  if (!coupon) {
    throw new CouponError("This coupon code isn't valid.", 404);
  }
  if (coupon.startsAt && coupon.startsAt > now) {
    throw new CouponError("This coupon isn't active yet.");
  }
  if (coupon.expiresAt && coupon.expiresAt < now) {
    throw new CouponError("This coupon has expired.");
  }
  if (coupon.usageLimit !== null && coupon.usageCount >= coupon.usageLimit) {
    throw new CouponError("This coupon has reached its usage limit.", 409);
  }
  if (coupon.minOrderSubtotalInPaisa !== null && subtotalInPaisa < coupon.minOrderSubtotalInPaisa) {
    throw new CouponError(
      `This coupon needs an order subtotal of at least Rs. ${(coupon.minOrderSubtotalInPaisa / 100).toFixed(2)}.`,
    );
  }

  let discountInPaisa = computeDiscountInPaisa(coupon.discountType, coupon.discountValue, subtotalInPaisa);
  if (coupon.discountType === "percentage" && coupon.maxDiscountInPaisa !== null) {
    discountInPaisa = Math.min(discountInPaisa, coupon.maxDiscountInPaisa);
  }

  return { coupon, discountInPaisa };
}

/**
 * Atomically claims one use of a coupon (CAS on usageCount against
 * usageLimit — the actual race-safe enforcement, same pattern as
 * mfaBackupCodes/settleLedgerDue) and records the redemption for audit.
 * Both succeed together or neither does (caller runs this inside its own
 * transaction alongside the order UPDATE that actually applies the
 * discount).
 */
export async function redeemCoupon(
  tx: Transaction,
  params: {
    restaurantId: string;
    couponId: string;
    orderId: string;
    discountInPaisa: number;
    recordedByUserId?: string | null;
  },
) {
  const [claimed] = await tx
    .update(coupons)
    .set({ usageCount: sql`${coupons.usageCount} + 1`, updatedAt: new Date() })
    .where(
      and(
        eq(coupons.id, params.couponId),
        eq(coupons.restaurantId, params.restaurantId),
        or(isNull(coupons.usageLimit), gt(coupons.usageLimit, coupons.usageCount)),
      ),
    )
    .returning();

  if (!claimed) {
    // Either the coupon no longer belongs to this restaurant (shouldn't
    // happen — caller already resolved it under the same restaurantId) or
    // a concurrent redemption just claimed the last slot.
    throw new CouponError("This coupon has reached its usage limit.", 409);
  }

  const [redemption] = await tx
    .insert(couponRedemptions)
    .values({
      restaurantId: params.restaurantId,
      couponId: params.couponId,
      orderId: params.orderId,
      discountInPaisa: params.discountInPaisa,
      redeemedByUserId: params.recordedByUserId ?? null,
    })
    .returning();

  return { coupon: claimed, redemption };
}

/**
 * Releases a previously-redeemed coupon from one order — the inverse of
 * redeemCoupon, called whenever an order's applied coupon is being removed
 * or replaced (see the coupon route and the adjustments route's own call
 * site) so a removed/overwritten coupon doesn't permanently burn its usage
 * slot. A no-op (returns false) if this order has no live redemption row
 * for `couponId` — safe to call defensively even when the caller isn't
 * certain one exists.
 */
export async function unredeemCoupon(
  tx: Transaction,
  params: { restaurantId: string; couponId: string; orderId: string },
): Promise<boolean> {
  const [deleted] = await tx
    .delete(couponRedemptions)
    .where(
      and(
        eq(couponRedemptions.restaurantId, params.restaurantId),
        eq(couponRedemptions.couponId, params.couponId),
        eq(couponRedemptions.orderId, params.orderId),
      ),
    )
    .returning({ id: couponRedemptions.id });

  if (!deleted) return false;

  await tx
    .update(coupons)
    .set({ usageCount: sql`greatest(${coupons.usageCount} - 1, 0)`, updatedAt: new Date() })
    .where(and(eq(coupons.id, params.couponId), eq(coupons.restaurantId, params.restaurantId), gte(coupons.usageCount, 1)));

  return true;
}
