import { z } from "zod";

// Deliberately looser than feature-catalog.ts's FEATURES enum — a flag key
// can name something not yet (or never) added to that code-defined
// catalog (an experimental rollout key, a kill switch for something still
// in development). Shape-only validation; feature-catalog.ts's
// FEATURE_DESCRIPTIONS is used purely for display when a key happens to
// match a known one.
const featureKeyFieldSchema = z
  .string()
  .trim()
  .min(1, "Enter a feature key.")
  .max(60, "60 characters max.")
  .regex(/^[a-z0-9_]+$/, "Lowercase letters, numbers, and underscores only.");

export const createFeatureFlagSchema = z.object({
  key: featureKeyFieldSchema,
  name: z.string().trim().min(1, "Enter a name.").max(100),
  description: z.string().trim().min(1, "Enter a description.").max(500),
  defaultEnabled: z.boolean(),
});

/** Editing an existing flag — everything but the key itself (immutable once created, same reasoning as plans.key). */
export const updateFeatureFlagSchema = createFeatureFlagSchema.omit({ key: true }).partial();

/**
 * Setting a per-tenant override. `reason` required, not optional — every
 * override is a deliberate exception to the normal plan-based rule, same
 * "must justify the sensitive action" convention as platform role grants
 * and tenant suspension.
 */
export const setEntitlementOverrideSchema = z.object({
  featureKey: featureKeyFieldSchema,
  granted: z.boolean(),
  reason: z.string().trim().min(3, "Enter a short reason.").max(500),
});

export const clearEntitlementOverrideSchema = z.object({
  featureKey: featureKeyFieldSchema,
});
