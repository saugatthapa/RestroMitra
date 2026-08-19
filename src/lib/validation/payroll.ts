import { z } from "zod";
import { rupeesToPaisa } from "@/lib/money";
import { PAYOUT_METHODS } from "@/lib/finance/payout-methods";

const rupeeAmount = z
  .number()
  .positive("Amount must be greater than zero.")
  .max(10_000_000, "Amount is unreasonably large.")
  .transform((rupees) => rupeesToPaisa(rupees));

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a date as YYYY-MM-DD.");

/**
 * Paying a staff member is always a direct, immediate action (no
 * pending_approval/approved staging like expenses) — MANAGE_PAYROLL is a
 * single permission, not split into create/approve/pay tiers, so whoever
 * holds it (owner, accountant) just records the payout: choose a method
 * (cash means "manually enter the amount", matching the request — the
 * amount is ALWAYS manually entered here regardless of method, since
 * there's no payout API to pull a number from either way) and it's booked.
 */
export const createPayrollPaymentSchema = z.object({
  userRoleId: z.string().uuid("Choose a staff member."),
  amount: rupeeAmount,
  paymentMethod: z.enum(PAYOUT_METHODS),
  payPeriodLabel: z.string().trim().max(100).optional().or(z.literal("")),
  periodStart: isoDate.optional(),
  periodEnd: isoDate.optional(),
  note: z.string().trim().max(1000).optional().or(z.literal("")),
});
