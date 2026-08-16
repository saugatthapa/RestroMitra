import { z } from "zod";
import { rupeesToPaisa } from "@/lib/money";
import { LEDGER_DIRECTIONS, MANUAL_LEDGER_CATEGORIES } from "@/lib/ledger-categories";

const rupeeAmount = z
  .number()
  .positive("Amount must be greater than zero.")
  .max(10_000_000, "Amount is unreasonably large.")
  .transform((rupees) => rupeesToPaisa(rupees));

// YYYY-MM-DD, matching the `date` column type — same pattern as
// expenses.ts's isoDate.
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a date as YYYY-MM-DD.");

export const createLedgerEntrySchema = z.object({
  direction: z.enum(LEDGER_DIRECTIONS),
  category: z.enum(MANUAL_LEDGER_CATEGORIES as [string, ...string[]]),
  amount: rupeeAmount,
  entryDate: isoDate.optional(),
  counterpartyName: z.string().trim().max(200).optional().or(z.literal("")),
  description: z.string().trim().min(1, "A description is required.").max(300),
  note: z.string().trim().max(1000).optional().or(z.literal("")),
  markAsDue: z.boolean().optional(),
});

export const settleLedgerDueSchema = z.object({
  amount: rupeeAmount,
  note: z.string().trim().max(500).optional().or(z.literal("")),
});
