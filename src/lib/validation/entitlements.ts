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

// Optional expiry for a temporary override — blank/omitted means "no
// expiry" (permanent, the historical default and still the common case).
// When given, must be a real ISO datetime that isn't already in the past:
// an override created already-expired would never actually take effect
// (resolveFeatureAccess treats a past expiresAt as absent — see
// entitlements.ts), so that's a mistake worth rejecting up front rather
// than silently accepting a no-op grant.
const overrideExpiresAtFieldSchema = z
  .string()
  .datetime()
  .optional()
  .or(z.literal(""))
  .refine((value) => !value || new Date(value).getTime() >= Date.now(), {
    message: "Expiry must be now or in the future.",
  });

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
  expiresAt: overrideExpiresAtFieldSchema,
});

export const clearEntitlementOverrideSchema = z.object({
  featureKey: featureKeyFieldSchema,
});
