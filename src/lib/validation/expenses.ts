import { z } from "zod";
import { rupeesToPaisa } from "@/lib/money";
import { EXPENSE_PAYMENT_METHODS } from "@/lib/finance/expense-payment-methods";

const rupeeAmount = z
  .number()
  .positive("Amount must be greater than zero.")
  .max(10_000_000, "Amount is unreasonably large.")
  .transform((rupees) => rupeesToPaisa(rupees));

// YYYY-MM-DD, matching the `date` column type — deliberately not a full
// timestamp; an expense's "date" is a calendar day, not a moment.
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a date as YYYY-MM-DD.");

/**
 * paymentMethod is optional at submission time — it's only meaningful (and
 * only required, enforced in the route) when the creator's own permissions
 * mean this lands as "paid" immediately. A staff member submitting a
 * request with no pay authority has no method to give yet; that's decided
 * later, at the /pay step, by whoever actually pays it.
 */
export const createExpenseSchema = z.object({
  categoryId: z.string().uuid("Choose a category."),
  amount: rupeeAmount,
  description: z.string().trim().min(1, "A description is required.").max(300),
  // Defaults to today (server-side, see the route) when omitted.
  expenseDate: isoDate.optional(),
  note: z.string().trim().max(1000).optional().or(z.literal("")),
  branchId: z.string().uuid().nullable().optional(),
  paymentMethod: z.enum(EXPENSE_PAYMENT_METHODS).optional(),
});

export const updateExpenseSchema = z
  .object({
    categoryId: z.string().uuid().optional(),
    amount: rupeeAmount.optional(),
    description: z.string().trim().min(1).max(300).optional(),
    expenseDate: isoDate.optional(),
    note: z.string().trim().max(1000).optional().or(z.literal("")),
    branchId: z.string().uuid().nullable().optional(),
    isVoided: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "Provide at least one field to update.",
  });

export const rejectExpenseSchema = z.object({
  reason: z.string().trim().min(1, "A reason is required.").max(300),
});

export const payExpenseSchema = z.object({
  paymentMethod: z.enum(EXPENSE_PAYMENT_METHODS),
});
