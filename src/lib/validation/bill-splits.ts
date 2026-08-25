import { z } from "zod";

const splitItemInputSchema = z.object({
  orderItemId: z.string().uuid(),
  // Bounded generously (not to the usual 1-50 cart quantity cap) since a
  // combo-exploded order item's own row quantity can run much higher
  // (component quantity × bundle quantity, see menuComboItems' own
  // comment) — the REAL ceiling is that item row's actual `quantity`,
  // checked against the database in the route, not here.
  quantity: z.number().int().min(1).max(1000),
});

// Whole-state-replace for the order's entire set of shares, same
// convention as updateComboSchema's `items` and order-adjustments' PATCH
// — every PUT submits the COMPLETE new set of splits, not a patch. See
// orderBillSplits' own doc comment in schema.ts for why shares are always
// redefined together rather than edited one at a time.
export const replaceBillSplitsSchema = z.object({
  splits: z
    .array(
      z.object({
        label: z.string().trim().min(1, "Give this share a name.").max(100),
        items: z.array(splitItemInputSchema).max(100).default([]),
      }),
    )
    .max(20, "A bill can be split at most 20 ways."),
});
export type ReplaceBillSplitsInput = z.infer<typeof replaceBillSplitsSchema>;
