import { z } from "zod";
import { FEATURES } from "@/lib/feature-catalog";

// Same shape as a plan's `key` column (varchar(40)) — lowercase-with-
// hyphens/underscores by convention (the 3 seeded keys: starter, growth,
// pro), but not enforced as a strict slug pattern since a platform admin
// choosing this is trusted the same way choosing any other catalog field is.
const planKeyFieldSchema = z
  .string()
  .trim()
  .min(1, "Enter a plan key.")
  .max(40, "40 characters max.")
  .regex(/^[a-z0-9_-]+$/, "Lowercase letters, numbers, hyphens, and underscores only.");

const FEATURE_KEY_VALUES = Object.values(FEATURES) as string[];

/**
 * A brand-new plan. `key` is immutable once created (see updatePlanSchema,
 * which omits it) — every restaurants.planKey/subscriptionEvents.planKey
 * row and every audit log entry references it by string, so renaming a key
 * in place would silently orphan history.
 */
export const createPlanSchema = z.object({
  key: planKeyFieldSchema,
  name: z.string().trim().min(1, "Enter a plan name.").max(100),
  tagline: z.string().trim().min(1, "Enter a tagline.").max(200),
  priceInPaisaMonthly: z.number().int().min(0, "Price can't be negative."),
  // null = unlimited, matches the DB column's own nullability.
  maxStaff: z.number().int().min(0).nullable(),
  maxBranches: z.number().int().min(0).nullable(),
  highlight: z.boolean(),
  features: z.array(z.string().trim().min(1).max(200)).max(30),
  featureKeys: z.array(z.enum(FEATURE_KEY_VALUES as [string, ...string[]])).max(FEATURE_KEY_VALUES.length),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
});

/** Editing an existing plan — everything but the key itself. */
export const updatePlanSchema = createPlanSchema.omit({ key: true }).partial();

export type CreatePlanInput = z.infer<typeof createPlanSchema>;
export type UpdatePlanInput = z.infer<typeof updatePlanSchema>;
