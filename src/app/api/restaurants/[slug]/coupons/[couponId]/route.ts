import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { coupons } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { updateCouponSchema } from "@/lib/validation/coupons";
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

    const [updated] = await db
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
        ...(data.startsAt !== undefined ? { startsAt: data.startsAt ? new Date(data.startsAt) : null } : {}),
        ...(data.expiresAt !== undefined ? { expiresAt: data.expiresAt ? new Date(data.expiresAt) : null } : {}),
        ...(data.note !== undefined ? { note: data.note?.trim() || null } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(coupons.id, couponId), eq(coupons.restaurantId, restaurantId)))
      .returning();

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "coupon.updated",
      resourceType: "coupon",
      resourceId: couponId,
      ipAddress: getClientIp(request),
      metadata: { changes: data },
    });

    return NextResponse.json({ coupon: updated });
  } catch (err) {
    return toErrorResponse(err);
  }
}
