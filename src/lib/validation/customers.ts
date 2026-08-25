import { z } from "zod";
import { rupeesToPaisa } from "@/lib/money";

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
  // Commercial Launch Phase B.5 — Customer Credit. Rupees in, paisa out
  // (same rupeeAmount-style transform ledger.ts's own schema uses) — null
  // explicitly clears the limit back to "unlimited" (the default), distinct
  // from omitting the field entirely (leave whatever's already set).
  creditLimit: z
    .number()
    .nonnegative("Credit limit can't be negative.")
    .max(10_000_000, "That's an unreasonably large credit limit.")
    .nullable()
    .transform((rupees) => (rupees === null ? null : rupeesToPaisa(rupees)))
    .optional(),
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

// Commercial Launch Phase B.5 — Customer Credit. Same shape as
// settleLedgerDueSchema (ledger.ts) — a lump-sum payment amount plus an
// optional note — kept as its own schema (rather than importing that one)
// since it lives in a different validation module and the two are free to
// diverge later without one accidentally changing the other.
export const settleCustomerCreditSchema = z.object({
  amount: z
    .number()
    .positive("Amount must be greater than zero.")
    .max(10_000_000, "Amount is unreasonably large.")
    .transform((rupees) => rupeesToPaisa(rupees)),
  note: z.string().trim().max(500).optional().or(z.literal("")),
});
