import { z } from "zod";
import { rupeesToPaisa } from "@/lib/money";
import { DISCOUNT_TYPES, type DiscountType } from "@/lib/order-adjustments";

/**
 * Shared shape for "set the discount/service charge configuration" —
 * reused by both order creation (createStaffOrderSchema) and the dedicated
 * adjustments route. Deliberately whole-state, not a partial patch: every
 * submission carries the COMPLETE desired discount + service charge
 * configuration (matching how the POS/bill-view forms always submit their
 * full current state), so there's no ambiguity about what "omitted" means.
 *
 * discountPercent is 0-100 with up to 2 decimal places (e.g. 12.5 = 12.5%),
 * transformed to basis points server-side. discountFlatAmount is rupees,
 * transformed to paisa via the same rupeesToPaisa() helper every other
 * money input in this app uses. Exactly one of the two must be present
 * when discountType is set, and neither when it's null/omitted (see the
 * refine below) — this is a discriminated shape, not two independent
 * optional fields.
 */
export const orderAdjustmentsInputSchema = z
  .object({
    discountType: z.enum(DISCOUNT_TYPES).nullable().optional(),
    discountPercent: z.number().min(0).max(100).optional(),
    discountFlatAmount: z.number().min(0).max(10_000_000).optional(),
    discountReason: z.string().trim().max(300).optional().or(z.literal("")),
    serviceChargePercent: z.number().min(0).max(100).optional().default(0),
  })
  .refine(
    (d) => {
      if (d.discountType === "percentage") {
        return d.discountPercent !== undefined && d.discountFlatAmount === undefined;
      }
      if (d.discountType === "flat") {
        return d.discountFlatAmount !== undefined && d.discountPercent === undefined;
      }
      // No discount: neither value should be sent.
      return d.discountPercent === undefined && d.discountFlatAmount === undefined;
    },
    {
      message:
        "Provide discountPercent for a percentage discount, discountFlatAmount for a flat discount, or neither for no discount.",
    },
  );

export type OrderAdjustmentsInputParsed = z.infer<typeof orderAdjustmentsInputSchema>;

/**
 * Converts the validated, human-friendly input (percent / rupees) into the
 * basis-points-and-paisa shape order-adjustments.ts's computeOrderTotals()
 * expects. The one place this conversion happens, so creation and the
 * adjustments route can't compute it differently.
 */
export function resolveOrderAdjustmentsInput(parsed: OrderAdjustmentsInputParsed): {
  discountType: DiscountType | null;
  discountValue: number | null;
  discountReason: string | null;
  serviceChargeBasisPoints: number;
} {
  const discountType = parsed.discountType ?? null;
  const discountValue =
    discountType === "percentage"
      ? Math.round((parsed.discountPercent ?? 0) * 100)
      : discountType === "flat"
        ? rupeesToPaisa(parsed.discountFlatAmount ?? 0)
        : null;
  return {
    discountType,
    discountValue,
    discountReason: discountType ? parsed.discountReason?.trim() || null : null,
    serviceChargeBasisPoints: Math.round((parsed.serviceChargePercent ?? 0) * 100),
  };
}
