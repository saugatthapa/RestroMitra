import { z } from "zod";
import { rupeesToPaisa } from "@/lib/money";
import { DISCOUNT_TYPES } from "@/lib/order-adjustments";

// Human-typeable codes: letters/digits/hyphens, matching how staff would
// actually say/type one out loud ("SAVE20", "NEWYEAR-10").
const couponCodeRegex = /^[A-Za-z0-9-]+$/;

// Gap-audit follow-up (P1 revenue leakage) — restriction id lists shared by
// create and update. Deliberately capped well above any realistic
// restaurant's branch/menu/category count; ownership (do these ids
// actually belong to this restaurant) is checked separately in
// assertCouponRestrictionsOwnership (coupons.ts) since zod has no DB
// access — this only shapes the request.
const idListSchema = z.array(z.string().uuid()).max(200).optional();

export const createCouponSchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(3, "Code must be at least 3 characters.")
      .max(30, "Code must be at most 30 characters.")
      .regex(couponCodeRegex, "Use only letters, numbers, and hyphens."),
    discountType: z.enum(DISCOUNT_TYPES),
    discountPercent: z.number().min(0.01).max(100).optional(),
    discountFlatAmount: z.number().min(0.01).max(10_000_000).optional(),
    maxDiscount: z.number().positive().max(10_000_000).optional(),
    minOrderSubtotal: z.number().nonnegative().max(10_000_000).optional(),
    usageLimit: z.number().int().positive().max(1_000_000).optional(),
    // Per-customer usage cap — how many times ONE customer may redeem this
    // coupon, independent of (and always <=, though not enforced as such —
    // a perCustomerLimit above usageLimit is just never reachable) the
    // restaurant-wide usageLimit above.
    perCustomerLimit: z.number().int().positive().max(1_000_000).optional(),
    // Valid only on a customer's chronologically first non-cancelled order
    // at this restaurant — see resolveCoupon's own comment for exactly how
    // "first" is determined.
    firstOrderOnly: z.boolean().optional(),
    // Branch/menu-item/category restrictions — omitted or empty = no
    // restriction of that kind (the pre-existing, unrestricted behavior).
    // See assertCouponRestrictionsOwnership for the tenant-ownership check
    // and resolveCoupon for exactly how each is enforced.
    branchIds: idListSchema,
    menuItemIds: idListSchema,
    categoryIds: idListSchema,
    startsAt: z.string().datetime().optional().or(z.literal("")),
    expiresAt: z.string().datetime().optional().or(z.literal("")),
    note: z.string().trim().max(500).optional().or(z.literal("")),
  })
  .refine(
    (d) =>
      d.discountType === "percentage"
        ? d.discountPercent !== undefined && d.discountFlatAmount === undefined
        : d.discountFlatAmount !== undefined && d.discountPercent === undefined,
    {
      message: "Provide discountPercent for a percentage coupon, or discountFlatAmount for a flat one.",
    },
  );

export type CreateCouponInput = z.infer<typeof createCouponSchema>;

export function resolveCreateCouponInput(parsed: CreateCouponInput) {
  return {
    discountType: parsed.discountType,
    discountValue:
      parsed.discountType === "percentage"
        ? Math.round((parsed.discountPercent ?? 0) * 100)
        : rupeesToPaisa(parsed.discountFlatAmount ?? 0),
    maxDiscountInPaisa: parsed.maxDiscount !== undefined ? rupeesToPaisa(parsed.maxDiscount) : null,
    minOrderSubtotalInPaisa:
      parsed.minOrderSubtotal !== undefined ? rupeesToPaisa(parsed.minOrderSubtotal) : null,
    usageLimit: parsed.usageLimit ?? null,
    perCustomerLimit: parsed.perCustomerLimit ?? null,
    firstOrderOnly: parsed.firstOrderOnly ?? false,
    branchIds: parsed.branchIds ?? [],
    menuItemIds: parsed.menuItemIds ?? [],
    categoryIds: parsed.categoryIds ?? [],
    startsAt: parsed.startsAt ? new Date(parsed.startsAt) : null,
    expiresAt: parsed.expiresAt ? new Date(parsed.expiresAt) : null,
    note: parsed.note?.trim() || null,
  };
}

// Partial update — every field optional, only isActive/expiry/usage-style
// fields are realistically edited after a coupon's been shared with
// customers (its code/discount value staying fixed avoids "the coupon
// changed value after someone screenshotted it" confusion), but nothing
// here technically forbids changing them since staff may still be
// iterating on a coupon before it's gone out.
export const updateCouponSchema = z.object({
  discountType: z.enum(DISCOUNT_TYPES).optional(),
  discountPercent: z.number().min(0.01).max(100).optional(),
  discountFlatAmount: z.number().min(0.01).max(10_000_000).optional(),
  maxDiscount: z.number().positive().max(10_000_000).nullable().optional(),
  minOrderSubtotal: z.number().nonnegative().max(10_000_000).nullable().optional(),
  usageLimit: z.number().int().positive().max(1_000_000).nullable().optional(),
  perCustomerLimit: z.number().int().positive().max(1_000_000).nullable().optional(),
  firstOrderOnly: z.boolean().optional(),
  // Same whole-state-replace semantics as updateComboSchema's `items`:
  // when present, the COMPLETE new restriction set, not a patch — an
  // explicit `[]` clears the restriction entirely, `undefined` (the field
  // simply omitted) leaves it untouched.
  branchIds: idListSchema,
  menuItemIds: idListSchema,
  categoryIds: idListSchema,
  startsAt: z.string().datetime().nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  isActive: z.boolean().optional(),
});

export const applyCouponSchema = z.object({
  code: z.string().trim().min(1, "Enter a coupon code.").max(30),
});
