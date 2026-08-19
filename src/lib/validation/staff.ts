import { z } from "zod";
import { ASSIGNABLE_STAFF_ROLES } from "@/lib/staff-roles";
import { staffSalarySchema } from "@/lib/validation/staff-salary";

// Nepal mobile numbers: 10 digits, commonly starting 9. Same pattern/regex
// as src/lib/validation/auth.ts — kept in sync deliberately, since a staff
// phone number goes through the exact same uniqueness constraint on
// `users.phone` as a self-registered account.
const nepalPhoneRegex = /^9[678]\d{8}$/;

/**
 * fullName/password are optional here because "add staff" is a
 * find-or-create against the phone number: if an account with this phone
 * already exists (e.g. someone who works at another restaurant, or
 * registered themselves once), this route just grants them a new role at
 * THIS restaurant and fullName/password are ignored. The route enforces
 * that both are present when actually creating a brand-new account —
 * that condition depends on a DB lookup, so it can't be expressed in the
 * schema alone.
 */
export const addStaffSchema = z.object({
  phone: z
    .string()
    .trim()
    .regex(nepalPhoneRegex, "Enter a valid 10-digit Nepal mobile number."),
  fullName: z.string().trim().min(2, "Enter a full name.").max(200).optional(),
  password: z.string().min(8, "Password must be at least 8 characters.").optional(),
  role: z.enum(ASSIGNABLE_STAFF_ROLES),
  // Phase 11a — optional: omitted (or explicitly null) means unrestricted
  // access across every branch of the restaurant, same as the owner's own
  // grant. When set, verified server-side to belong to this restaurant
  // before it's stored (never trusted at face value).
  branchId: z.string().uuid().nullable().optional(),
  // Phase 22 — optional salary info, collected in the same "add staff"
  // submit so the owner fills it in once instead of a separate later
  // step. Accepted here at the schema level regardless of caller, but the
  // route only actually persists it when the caller holds MANAGE_PAYROLL
  // (see staff/route.ts) — salary stays behind the same permission wall
  // as every other payroll action, even when bundled into this form.
  salary: staffSalarySchema.optional(),
});

export const updateStaffSchema = z
  .object({
    role: z.enum(ASSIGNABLE_STAFF_ROLES).optional(),
    isActive: z.boolean().optional(),
    branchId: z.string().uuid().nullable().optional(),
  })
  .refine(
    (data) => data.role !== undefined || data.isActive !== undefined || data.branchId !== undefined,
    { message: "Provide a role change, an active-status change, a branch change, or a combination." },
  );
