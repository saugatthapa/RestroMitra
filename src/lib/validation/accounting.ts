import { z } from "zod";
import { rupeesToPaisa } from "@/lib/money";

const ACCOUNT_TYPES = ["asset", "liability", "equity", "income", "expense"] as const;
const NORMAL_BALANCES = ["debit", "credit"] as const;
const VOUCHER_TYPES = [
  "journal",
  "sales",
  "purchase",
  "payment",
  "expense",
  "refund",
  "contra",
  "payroll",
  "opening_balance",
] as const;

export const createAccountSchema = z.object({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(150),
  type: z.enum(ACCOUNT_TYPES),
  normalBalance: z.enum(NORMAL_BALANCES),
  branchId: z.string().uuid().nullable().optional(),
  parentAccountId: z.string().uuid().nullable().optional(),
  description: z.string().trim().max(500).optional().or(z.literal("")),
});

export const updateAccountSchema = z.object({
  name: z.string().trim().min(1).max(150).optional(),
  isActive: z.boolean().optional(),
  description: z.string().trim().max(500).optional().or(z.literal("")),
});

const rupeeAmount = z
  .number()
  .positive("Amount must be greater than zero.")
  .max(100_000_000, "Amount is unreasonably large.")
  .transform((rupees) => rupeesToPaisa(rupees));

// One journal-voucher line as entered by a human — "amount" (rupees) + a
// side, rather than separate debit/credit rupee fields, since a manual
// entry form naturally asks "debit or credit, how much" per line rather
// than two amount boxes where one is always zero.
const voucherLineInputSchema = z.object({
  accountId: z.string().uuid(),
  side: z.enum(["debit", "credit"]),
  amount: rupeeAmount,
  description: z.string().trim().max(300).optional().or(z.literal("")),
  customerId: z.string().uuid().nullable().optional(),
  supplierId: z.string().uuid().nullable().optional(),
});

export const createJournalVoucherSchema = z.object({
  branchId: z.string().uuid(),
  voucherDate: z.string().refine((v) => !Number.isNaN(new Date(v).getTime()), "Invalid date."),
  reference: z.string().trim().max(100).optional().or(z.literal("")),
  narration: z.string().trim().max(500).optional().or(z.literal("")),
  lines: z.array(voucherLineInputSchema).min(2).max(50),
});

export const createOpeningBalanceVoucherSchema = z.object({
  branchId: z.string().uuid(),
  voucherDate: z.string().refine((v) => !Number.isNaN(new Date(v).getTime()), "Invalid date."),
  narration: z.string().trim().max(500).optional().or(z.literal("")),
  // Every line here debits/credits its own real account; the engine adds
  // ONE extra line against Opening Balance Equity (3200) to balance
  // whatever these don't already net to zero — see the route.
  lines: z.array(voucherLineInputSchema).min(1).max(100),
});

export const reverseVoucherSchema = z.object({
  reason: z.string().trim().min(1, "A reason is required.").max(300),
});

export const createAccountingPeriodSchema = z.object({
  branchId: z.string().uuid().nullable().optional(),
  periodStart: z.string().refine((v) => !Number.isNaN(new Date(v).getTime()), "Invalid date."),
  periodEnd: z.string().refine((v) => !Number.isNaN(new Date(v).getTime()), "Invalid date."),
});

export const reopenAccountingPeriodSchema = z.object({
  reason: z.string().trim().min(1, "A reason is required.").max(300),
});

export const accountingVoucherTypeSchema = z.enum(VOUCHER_TYPES);

// A plain "YYYY-MM-DD" check for report query params (?asOfDate=, ?fromDate=,
// ?toDate=) — stricter than the voucher-input date refine above (which just
// needs something `new Date()` can parse) since these come from a raw query
// string rather than a date-picker payload.
export const reportDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD.");

// ---------------------------------------------------------------------------
// Phase 5, Slice 5b — real bank accounts + bank-statement reconciliation.
// ---------------------------------------------------------------------------

export const createBankAccountSchema = z.object({
  bankName: z.string().trim().min(1, "Enter a bank name.").max(150),
  accountNumber: z.string().trim().max(60).optional().or(z.literal("")),
  branchName: z.string().trim().max(150).optional().or(z.literal("")),
  notes: z.string().trim().max(1000).optional().or(z.literal("")),
});

export const updateBankAccountSchema = z
  .object({
    bankName: z.string().trim().min(1).max(150).optional(),
    accountNumber: z.string().trim().max(60).optional().or(z.literal("")),
    branchName: z.string().trim().max(150).optional().or(z.literal("")),
    notes: z.string().trim().max(1000).optional().or(z.literal("")),
    isActive: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "Provide at least one field to update.",
  });

const statementDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD.");

export const createBankReconciliationSchema = z.object({
  bankAccountId: z.string().uuid("Choose a bank account."),
  statementDate: statementDateSchema,
  statementClosingBalance: rupeeAmount,
  notes: z.string().trim().max(1000).optional().or(z.literal("")),
});

export const updateBankReconciliationSchema = z
  .object({
    statementClosingBalance: rupeeAmount.optional(),
    notes: z.string().trim().max(1000).optional().or(z.literal("")),
    // The full desired set of checked-off voucher line ids — the route
    // diffs this against what's currently cleared (see setClearedLines's
    // own doc comment), so the client always sends its complete current
    // checklist state, never a delta.
    clearedVoucherLineIds: z.array(z.string().uuid()).max(2000).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "Provide at least one field to update.",
  });
