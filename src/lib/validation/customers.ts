import { z } from "zod";

// Nepal mobile numbers: 10 digits, commonly starting 9. Same pattern/regex
// as src/lib/validation/auth.ts and staff.ts — kept in sync deliberately.
const nepalPhoneRegex = /^9[678]\d{8}$/;

// YYYY-MM-DD, matching the `date` column type (see expenses.ts's isoDate
// for the same pattern) — a birth date is a calendar day, not a moment.
// Deliberately not future-restricted beyond "not later than today" isn't
// enforced here either; a slightly wrong birth year someone mistypes is
// harmless (only month+day are ever read — see loyalty-birthday.ts) and
// not worth a hard validation failure that blocks saving the record.
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a date as YYYY-MM-DD.");

export const createCustomerSchema = z.object({
  phone: z
    .string()
    .trim()
    .regex(nepalPhoneRegex, "Enter a valid 10-digit Nepal mobile number."),
  fullName: z.string().trim().min(2, "Enter a full name.").max(200),
  email: z.string().trim().email("Enter a valid email address.").optional().or(z.literal("")),
  dateOfBirth: isoDate.optional().or(z.literal("")),
  notes: z.string().trim().max(1000).optional().or(z.literal("")),
});

export const updateCustomerSchema = z.object({
  fullName: z.string().trim().min(2).max(200).optional(),
  email: z.string().trim().email("Enter a valid email address.").optional().or(z.literal("")),
  dateOfBirth: isoDate.optional().or(z.literal("")),
  notes: z.string().trim().max(1000).optional().or(z.literal("")),
  isActive: z.boolean().optional(),
});

export const adjustLoyaltySchema = z.object({
  points: z
    .number()
    .int("Points must be a whole number.")
    .positive("Points must be greater than zero.")
    .max(1_000_000, "That's an unreasonably large point adjustment."),
  direction: z.enum(["add", "redeem"]),
  reason: z.string().trim().min(1, "A reason is required.").max(300),
});
