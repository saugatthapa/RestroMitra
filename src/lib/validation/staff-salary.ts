import { z } from "zod";
import { rupeesToPaisa } from "@/lib/money";
import { SALARY_TYPES } from "@/lib/finance/salary-type";
import { PAYOUT_METHODS } from "@/lib/finance/payout-methods";

const rupeeAmount = z
  .number()
  .positive("Salary amount must be greater than zero.")
  .max(10_000_000, "Amount is unreasonably large.")
  .transform((rupees) => rupeesToPaisa(rupees));

/**
 * Bank fields are always optional at the schema level — a staff member
 * might be paid in cash only, or the owner might fill this in later from
 * the Payroll tab — but the UI presents them as expected input whenever
 * "Bank transfer" is chosen as the payment method, matching the "ask all
 * required info while creating the staff account" request without
 * hard-blocking staff creation on banking details nobody has typed in yet.
 */
export const staffSalarySchema = z.object({
  salaryType: z.enum(SALARY_TYPES),
  amount: rupeeAmount,
  paymentMethod: z.enum(PAYOUT_METHODS).optional(),
  bankName: z.string().trim().max(150).optional().or(z.literal("")),
  bankAccountNumber: z.string().trim().max(50).optional().or(z.literal("")),
  bankAccountHolder: z.string().trim().max(200).optional().or(z.literal("")),
  note: z.string().trim().max(1000).optional().or(z.literal("")),
});

export const updateStaffSalarySchema = staffSalarySchema;
