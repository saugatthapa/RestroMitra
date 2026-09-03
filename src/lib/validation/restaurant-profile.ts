import { z } from "zod";
import { imageUrlSchema } from "./image";

/**
 * The restaurant-profile fields that don't already have a dedicated route:
 * PAN/VAT lives in tax-settings.ts (FiscalSettingsPanel), the KOT ticket
 * header lives in kot-settings.ts (KotSettingsPanel) — see those files' own
 * comments for why they shipped as small standalone routes ahead of this
 * one. This is the "general restaurant-profile endpoint" both of those
 * comments said didn't exist yet, backing the dashboard's Settings page.
 *
 * Same field set and constraints as onboarding's createRestaurantSchema
 * (src/lib/validation/onboarding.ts) for the fields that overlap — an
 * owner editing these later shouldn't face looser or stricter rules than
 * creating the restaurant did. `type`, `openTime`/`closeTime` are
 * deliberately left out of this pass (see SettingsBoard.tsx's own note);
 * this covers exactly the fields that currently have no self-service edit
 * path anywhere in the app.
 */
export const updateRestaurantProfileSchema = z.object({
  name: z.string().trim().min(2, "Restaurant name is required.").max(200),
  address: z.string().trim().min(2, "Address is required.").max(500),
  city: z.string().trim().min(1, "City is required.").max(100),
  district: z.string().trim().min(1, "District is required.").max(100),
  phone: z
    .string()
    .trim()
    .regex(/^9[678]\d{8}$/, "Enter a valid 10-digit Nepal mobile number."),
  logoUrl: imageUrlSchema().optional().or(z.literal("")),
});

export type UpdateRestaurantProfileInput = z.infer<typeof updateRestaurantProfileSchema>;
