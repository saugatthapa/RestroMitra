import "server-only";
import { and, eq, gt, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { db, type Transaction } from "@/db";
import {
  coupons,
  couponRedemptions,
  couponBranches,
  couponMenuItems,
  couponCategories,
  couponCustomerRedemptions,
  orders,
  orderItems,
  menuItems,
  branches,
  categories,
} from "@/db/schema";
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
 *
 * Gap-audit follow-up (P1 revenue leakage) — four more eligibility
 * conditions layered on afterward: per-customer usage cap, branch
 * restriction, menu-item/category restriction, and first-order-only. Same
 * split as the original fields: resolveCoupon is an ADVISORY precheck (a
 * friendly early rejection so the customer/staff sees a clear message
 * before anything is written), redeemCoupon is the actual atomic source of
 * truth for anything that can be raced. Only the per-customer cap is
 * raceable the same way the global usageLimit is (two concurrent
 * redemptions both reading "under the limit" before either commits) — the
 * branch/category/first-order checks are single-shot facts about an
 * already-existing order, not a shared mutable counter, so they don't need
 * a CAS.
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
 * Everything resolveCoupon needs about the ORDER a coupon is being applied
 * to, beyond its subtotal — branch, linked customer (if any), and enough of
 * its identity/history to evaluate the first-order and menu/category
 * restrictions. The one call site (orders/[orderId]/coupon route) already
 * has all of this loaded from the order row it just fetched.
 */
export type CouponEligibilityContext = {
  branchId: string;
  /** Null/undefined for a guest order with no linked CRM customer — see resolveCoupon's own notes on what that means for perCustomerLimit/firstOrderOnly. */
  customerId?: string | null;
  orderId: string;
  orderCreatedAt: Date;
};

/**
 * Looks up a coupon by code and checks every eligibility rule EXCEPT the
 * usage-limit / per-customer-limit races themselves (those are enforced
 * atomically by redeemCoupon's own compare-and-swap at the moment of actual
 * redemption — the checks here are just a friendly early rejection, not the
 * source of truth). Returns the coupon plus the discount it resolves to for
 * THIS order (already clamped by maxDiscountInPaisa for a percentage
 * coupon, and — see the menu/category restriction block below — computed
 * against only the qualifying items' subtotal when the coupon is item
 * -restricted).
 */
export async function resolveCoupon(
  restaurantId: string,
  rawCode: string,
  subtotalInPaisa: number,
  context: CouponEligibilityContext,
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

  // Branch restriction — zero rows in couponBranches means "valid
  // everywhere" (the pre-existing, unrestricted behavior); one or more
  // means the order's branch must be among them.
  const branchRestrictions = await db
    .select({ branchId: couponBranches.branchId })
    .from(couponBranches)
    .where(eq(couponBranches.couponId, coupon.id));
  if (branchRestrictions.length > 0 && !branchRestrictions.some((r) => r.branchId === context.branchId)) {
    throw new CouponError("This coupon isn't valid at this branch.");
  }

  // Per-customer usage cap and first-order-only both need a real, linked
  // customer to attribute usage/history to — a guest order (customerId
  // null, just a free-text name/phone snapshot) can't be reliably
  // identified across orders, so a coupon carrying either restriction
  // simply isn't redeemable on a guest order rather than silently treating
  // every guest as a fresh, unlimited customer (that would BE the exact
  // leak this whole feature closes).
  const needsCustomer = coupon.perCustomerLimit !== null || coupon.firstOrderOnly;
  if (needsCustomer && !context.customerId) {
    throw new CouponError("This coupon requires an order linked to a customer account.");
  }

  if (coupon.perCustomerLimit !== null && context.customerId) {
    const [usage] = await db
      .select({ redemptionCount: couponCustomerRedemptions.redemptionCount })
      .from(couponCustomerRedemptions)
      .where(
        and(
          eq(couponCustomerRedemptions.couponId, coupon.id),
          eq(couponCustomerRedemptions.customerId, context.customerId),
        ),
      )
      .limit(1);
    if (usage && usage.redemptionCount >= coupon.perCustomerLimit) {
      throw new CouponError("This customer has already redeemed this coupon the maximum number of times.", 409);
    }
  }

  // First-order-only — "first" is determined by immutable chronology (this
  // order's own createdAt/id vs. every other non-cancelled order this
  // customer has at this restaurant), NOT by a mutable "is this their first
  // order" flag anywhere. That makes it race-safe for free: two orders
  // created concurrently by the same customer can't both be earliest, so at
  // most one of them will ever pass this check, regardless of which order
  // the coupon happens to be applied to first. A cancelled order doesn't
  // count against "first" — a customer who abandoned/cancelled an initial
  // attempt should still get the welcome offer on the order that actually
  // goes through.
  if (coupon.firstOrderOnly && context.customerId) {
    const [priorOrder] = await db
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.restaurantId, restaurantId),
          eq(orders.customerId, context.customerId),
          ne(orders.id, context.orderId),
          ne(orders.status, "cancelled"),
          or(
            lt(orders.createdAt, context.orderCreatedAt),
            and(eq(orders.createdAt, context.orderCreatedAt), lt(orders.id, context.orderId)),
          ),
        ),
      )
      .limit(1);
    if (priorOrder) {
      throw new CouponError("This coupon is only valid on a customer's first order.");
    }
  }

  // Menu-item / category restriction. DECISION (see the gap-audit task this
  // implements): when a coupon is restricted to specific menu items and/or
  // categories, the discount is computed against ONLY the qualifying
  // items' combined lineTotalInPaisa (unit price × qty + addons — the same
  // per-line figure computeOrderPricing sums to produce the order's own
  // subtotalInPaisa, so "qualifying subtotal" is directly comparable to it)
  // — never the whole order's subtotal. A "20% off drinks" coupon on an
  // order with Rs 500 of food and Rs 100 of drinks discounts only the Rs
  // 100, not the Rs 600. An item qualifies if its menuItemId is in the
  // coupon's menu-item allow-list OR its category is in the coupon's
  // category allow-list (either list, not both required) — an item whose
  // menuItemId has since gone null (the menu item was deleted;
  // orderItems.menuItemId is "set null" on delete, traceability-only) can
  // never match, since there's nothing left to check it against.
  // minOrderSubtotalInPaisa above is still checked against the FULL order
  // subtotal (it's a threshold on order size, not on how much of it
  // qualifies) — only the discount computation below switches base.
  let effectiveSubtotalInPaisa = subtotalInPaisa;
  const [menuItemRestrictions, categoryRestrictionRows] = await Promise.all([
    db.select({ menuItemId: couponMenuItems.menuItemId }).from(couponMenuItems).where(eq(couponMenuItems.couponId, coupon.id)),
    db.select({ categoryId: couponCategories.categoryId }).from(couponCategories).where(eq(couponCategories.couponId, coupon.id)),
  ]);
  if (menuItemRestrictions.length > 0 || categoryRestrictionRows.length > 0) {
    const allowedMenuItemIds = new Set(menuItemRestrictions.map((r) => r.menuItemId));
    const allowedCategoryIds = new Set(categoryRestrictionRows.map((r) => r.categoryId));

    const items = await db
      .select({
        menuItemId: orderItems.menuItemId,
        categoryId: menuItems.categoryId,
        lineTotalInPaisa: orderItems.lineTotalInPaisa,
      })
      .from(orderItems)
      .leftJoin(menuItems, eq(orderItems.menuItemId, menuItems.id))
      .where(eq(orderItems.orderId, context.orderId));

    const qualifyingSubtotalInPaisa = items.reduce((sum, item) => {
      const qualifies =
        (item.menuItemId !== null && allowedMenuItemIds.has(item.menuItemId)) ||
        (item.categoryId !== null && allowedCategoryIds.has(item.categoryId));
      return qualifies ? sum + item.lineTotalInPaisa : sum;
    }, 0);

    if (qualifyingSubtotalInPaisa <= 0) {
      throw new CouponError("This coupon doesn't apply to any items in this order.");
    }
    effectiveSubtotalInPaisa = qualifyingSubtotalInPaisa;
  }

  let discountInPaisa = computeDiscountInPaisa(coupon.discountType, coupon.discountValue, effectiveSubtotalInPaisa);
  if (coupon.discountType === "percentage" && coupon.maxDiscountInPaisa !== null) {
    discountInPaisa = Math.min(discountInPaisa, coupon.maxDiscountInPaisa);
  }

  return { coupon, discountInPaisa };
}

/**
 * Atomically claims one use of a coupon — BOTH the restaurant-wide cap
 * (CAS on coupons.usageCount against usageLimit, unchanged from before) AND,
 * when the coupon has one, the per-customer cap (CAS-via-upsert on
 * couponCustomerRedemptions against perCustomerLimit) — and records the
 * redemption for audit. All of it succeeds together or none of it does
 * (caller runs this inside its own transaction alongside the order UPDATE
 * that actually applies the discount) — if the per-customer claim fails
 * after the global one already succeeded, throwing here rolls the global
 * claim back too.
 *
 * The per-customer CAS uses the same technique kot.ts's counter does
 * (`INSERT ... ON CONFLICT DO UPDATE`) but with a `setWhere` guard added —
 * Postgres resolves an `ON CONFLICT ... DO UPDATE` by taking a row-level
 * lock on the conflicting row (or serializing two concurrent first-time
 * inserts targeting the same conflict key against each other), so two
 * simultaneous redemption attempts by the same customer against a limit of
 * 1 are genuinely serialized by Postgres itself, not by anything in this
 * process — exactly the same guarantee the existing global-cap CAS relies
 * on, just upsert-shaped since the counter row may not exist yet for a
 * customer's first redemption.
 */
export async function redeemCoupon(
  tx: Transaction,
  params: {
    restaurantId: string;
    couponId: string;
    orderId: string;
    discountInPaisa: number;
    customerId?: string | null;
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

  if (claimed.perCustomerLimit !== null) {
    // Defense in depth, matching resolveCoupon's own precheck: a
    // perCustomerLimit coupon is never valid on an order with no linked
    // customer to attribute usage to.
    if (!params.customerId) {
      throw new CouponError("This coupon requires an order linked to a customer account.");
    }

    const [claimedCustomer] = await tx
      .insert(couponCustomerRedemptions)
      .values({
        restaurantId: params.restaurantId,
        couponId: params.couponId,
        customerId: params.customerId,
        redemptionCount: 1,
      })
      .onConflictDoUpdate({
        target: [couponCustomerRedemptions.couponId, couponCustomerRedemptions.customerId],
        set: { redemptionCount: sql`${couponCustomerRedemptions.redemptionCount} + 1`, updatedAt: new Date() },
        setWhere: sql`${couponCustomerRedemptions.redemptionCount} < ${claimed.perCustomerLimit}`,
      })
      .returning();

    if (!claimedCustomer) {
      throw new CouponError("This customer has already redeemed this coupon the maximum number of times.", 409);
    }
  }

  const [redemption] = await tx
    .insert(couponRedemptions)
    .values({
      restaurantId: params.restaurantId,
      couponId: params.couponId,
      orderId: params.orderId,
      discountInPaisa: params.discountInPaisa,
      customerId: params.customerId ?? null,
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
 * slot (global OR per-customer). A no-op (returns false) if this order has
 * no live redemption row for `couponId` — safe to call defensively even
 * when the caller isn't certain one exists.
 *
 * Reads customerId off the redemption row being deleted rather than taking
 * it as a param — couponRedemptions.customerId is the snapshot recorded by
 * redeemCoupon, so this stays symmetric without the caller needing to
 * re-derive/re-pass it.
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
    .returning({ id: couponRedemptions.id, customerId: couponRedemptions.customerId });

  if (!deleted) return false;

  await tx
    .update(coupons)
    .set({ usageCount: sql`greatest(${coupons.usageCount} - 1, 0)`, updatedAt: new Date() })
    .where(and(eq(coupons.id, params.couponId), eq(coupons.restaurantId, params.restaurantId), gte(coupons.usageCount, 1)));

  if (deleted.customerId) {
    await tx
      .update(couponCustomerRedemptions)
      .set({ redemptionCount: sql`greatest(${couponCustomerRedemptions.redemptionCount} - 1, 0)`, updatedAt: new Date() })
      .where(
        and(
          eq(couponCustomerRedemptions.couponId, params.couponId),
          eq(couponCustomerRedemptions.customerId, deleted.customerId),
          gte(couponCustomerRedemptions.redemptionCount, 1),
        ),
      );
  }

  return true;
}

// ---------------------------------------------------------------------------
// Restriction ownership — coupon create/edit
// ---------------------------------------------------------------------------

/**
 * Verifies every branch/menu-item/category id a coupon create/edit request
 * names actually belongs to THIS restaurant — same "resolve, don't trust"
 * posture, and the same pattern, as assertComboItemsOwnership in
 * combos.ts. Called by the coupons POST/PATCH routes before writing any
 * couponBranches/couponMenuItems/couponCategories row, so a cross-tenant id
 * (guessed, or copy-pasted from another restaurant's dashboard session)
 * fails loudly here instead of either silently being dropped or — far
 * worse — actually attaching a restriction that leaks another tenant's
 * branch/menu structure into this coupon's rules.
 */
export async function assertCouponRestrictionsOwnership(
  restaurantId: string,
  restrictions: { branchIds?: string[]; menuItemIds?: string[]; categoryIds?: string[] },
): Promise<void> {
  const { branchIds = [], menuItemIds = [], categoryIds = [] } = restrictions;

  if (branchIds.length > 0) {
    const owned = await db
      .select({ id: branches.id })
      .from(branches)
      .where(and(eq(branches.restaurantId, restaurantId), inArray(branches.id, branchIds)));
    const ownedIds = new Set(owned.map((r) => r.id));
    if (branchIds.some((id) => !ownedIds.has(id))) {
      throw new CouponError("One of the selected branches wasn't found.", 404);
    }
  }

  if (menuItemIds.length > 0) {
    const owned = await db
      .select({ id: menuItems.id })
      .from(menuItems)
      .where(and(eq(menuItems.restaurantId, restaurantId), inArray(menuItems.id, menuItemIds)));
    const ownedIds = new Set(owned.map((r) => r.id));
    if (menuItemIds.some((id) => !ownedIds.has(id))) {
      throw new CouponError("One of the selected menu items wasn't found.", 404);
    }
  }

  if (categoryIds.length > 0) {
    const owned = await db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.restaurantId, restaurantId), inArray(categories.id, categoryIds)));
    const ownedIds = new Set(owned.map((r) => r.id));
    if (categoryIds.some((id) => !ownedIds.has(id))) {
      throw new CouponError("One of the selected categories wasn't found.", 404);
    }
  }
}
