import { z } from "zod";
import { rupeesToPaisa } from "@/lib/money";
import { DISCOUNT_TYPES } from "@/lib/order-adjustments";

// Human-typeable codes: letters/digits/hyphens, matching how staff would
// actually say/type one out loud ("SAVE20", "NEWYEAR-10").
const couponCodeRegex = /^[A-Za-z0-9-]+$/;

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
  startsAt: z.string().datetime().nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  isActive: z.boolean().optional(),
});

export const applyCouponSchema = z.object({
  code: z.string().trim().min(1, "Enter a coupon code.").max(30),
});
