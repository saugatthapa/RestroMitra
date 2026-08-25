import { z } from "zod";
import { rupeesToPaisa } from "@/lib/money";

const comboItemInputSchema = z.object({
  menuItemId: z.string().uuid(),
  variantId: z.string().uuid().nullable().optional(),
  quantity: z.number().int().min(1).max(20),
});

export const createComboSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(150),
  description: z.string().trim().max(1000).optional().or(z.literal("")),
  price: z.number().positive("Price must be greater than zero.").max(10_000_000),
  items: z.array(comboItemInputSchema).min(1, "Add at least one item to the combo.").max(20),
});
export type CreateComboInput = z.infer<typeof createComboSchema>;

export function resolveComboPriceInPaisa(price: number): number {
  return rupeesToPaisa(price);
}

// Whole-state-replace for `items`, same convention as
// order-adjustments/route.ts and the planned Split Bill route: when
// present, `items` is the COMPLETE new set of combo items, not a patch —
// simpler and less error-prone than a separate add/remove/reorder API for
// what's realistically edited as a whole list at once in the combo builder
// UI.
export const updateComboSchema = z.object({
  name: z.string().trim().min(1).max(150).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  price: z.number().positive().max(10_000_000).optional(),
  items: z.array(comboItemInputSchema).min(1, "Add at least one item to the combo.").max(20).optional(),
  isActive: z.boolean().optional(),
});
