import { z } from "zod";
import { PLATFORM_ROLES } from "@/lib/rbac/platform-permissions";

// Nepal mobile numbers: 10 digits, commonly starting 9. Same pattern as
// src/lib/validation/staff.ts — kept in sync deliberately.
const nepalPhoneRegex = /^9[678]\d{8}$/;

/**
 * Deliberately NOT find-or-create like addStaffSchema — granting a
 * platform role to a phone number with no existing account would be a
 * dangling, unusable grant (no password to log in with) and, worse, would
 * let anyone SIGN UP with that phone afterward and inherit the platform
 * grant. The person must already have a real account (self-registered, or
 * a staff/owner account at some restaurant) before a platform role can be
 * layered onto it.
 */
export const grantPlatformRoleSchema = z.object({
  phone: z
    .string()
    .trim()
    .regex(nepalPhoneRegex, "Enter a valid 10-digit Nepal mobile number."),
  role: z.enum(PLATFORM_ROLES),
  // Required, not optional — every platform role grant needs a stated
  // reason on the record, since this is the single most sensitive action
  // in the whole console (see MANAGE_PLATFORM_ADMINS's own doc comment).
  reason: z.string().trim().min(3, "Enter a short reason for this grant.").max(500),
});

export const revokePlatformRoleSchema = z.object({
  reason: z.string().trim().min(3, "Enter a short reason for this revocation.").max(500),
});
