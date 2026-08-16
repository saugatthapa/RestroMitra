import { z } from "zod";
import { rupeesToPaisa } from "@/lib/money";
import { EXPENSE_CATEGORIES } from "@/lib/expense-categories";

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

export const createExpenseSchema = z.object({
  category: z.enum(EXPENSE_CATEGORIES),
  amount: rupeeAmount,
  description: z.string().trim().min(1, "A description is required.").max(300),
  // Defaults to today (server-side, see the route) when omitted.
  expenseDate: isoDate.optional(),
  note: z.string().trim().max(1000).optional().or(z.literal("")),
});

export const updateExpenseSchema = z
  .object({
    category: z.enum(EXPENSE_CATEGORIES).optional(),
    amount: rupeeAmount.optional(),
    description: z.string().trim().min(1).max(300).optional(),
    expenseDate: isoDate.optional(),
    note: z.string().trim().max(1000).optional().or(z.literal("")),
    isVoided: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "Provide at least one field to update.",
  });
