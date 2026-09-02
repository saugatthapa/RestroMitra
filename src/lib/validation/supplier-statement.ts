import { z } from "zod";
import { rupeesToPaisa } from "@/lib/money";
import { LEDGER_DIRECTIONS } from "@/lib/ledger-categories";

const rupeeAmount = z
  .number()
  .positive("Amount must be greater than zero.")
  .max(10_000_000, "Amount is unreasonably large.")
  .transform((rupees) => rupeesToPaisa(rupees));

// YYYY-MM-DD, matching the `date` column type — same pattern as
// ledger.ts's/expenses.ts's isoDate.
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a date as YYYY-MM-DD.");

/** Query-string range for GET .../statement — both ends optional. */
export const supplierStatementRangeSchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
});

/** Body for POST .../payments — a lump-sum payment, allocated oldest-due-first. */
export const recordSupplierPaymentSchema = z.object({
  amount: rupeeAmount,
  note: z.string().trim().max(500).optional().or(z.literal("")),
});

/** Body for POST .../adjustments — a manual credit/debit note. */
export const recordSupplierAdjustmentSchema = z.object({
  direction: z.enum(LEDGER_DIRECTIONS),
  amount: rupeeAmount,
  description: z.string().trim().min(1, "A description is required.").max(300),
  note: z.string().trim().max(1000).optional().or(z.literal("")),
  entryDate: isoDate.optional(),
});
