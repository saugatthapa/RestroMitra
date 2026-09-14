import "server-only";
import { and, eq } from "drizzle-orm";
import type { Transaction } from "@/db";
import { accountingVouchers } from "@/db/schema";
import { postVoucher, reverseVoucher } from "../post-voucher";
import { resolveAccountMappings } from "../account-mappings";
import { MAPPING_KEYS } from "../account-mapping-keys";
import { resolveBankAccountForPosting } from "../bank-accounts";
import { PAYOUT_METHOD_MAPPING_KEYS } from "./expenses";
import { restaurantDate } from "@/lib/restaurant-date";
import type { ExpensePaymentMethod } from "@/lib/finance/expense-payment-methods";

/**
 * Phase 4, Slice 4e — posts the Payroll Voucher at the moment a staff
 * payment is recorded (direct-pay `payroll/payments` POST — payroll has no
 * approve-then-pay two-step the way expenses does), per
 * ACCOUNTING_POLICY_AND_POSTING_MATRIX.md §6, cash-basis (the plan's own
 * Part 5 #7, confirmed): Dr Salary Expense, Cr the mapped clearing account
 * for the payment method actually used.
 *
 * The plan's own Part 5 #6 ("no payment-method field on a payroll payment
 * — default everything to Cash on Hand") turned out to be based on a stale
 * read of the schema: `payrollPayments.paymentMethod` is NOT NULL and uses
 * `expensePaymentMethodEnum` — the exact same six-value
 * cash/bank_transfer/esewa/khalti/mobile_banking/other set expenses use
 * (see expense-payment-methods.ts's own doc comment: payroll is literally
 * why that catalog moved to the shared payout-methods.ts in the first
 * place). So this reuses `PAYOUT_METHOD_MAPPING_KEYS` unchanged — the same
 * sign-off on the shared "Bank / Digital Payments" account for
 * bank_transfer/esewa/khalti/mobile_banking applies here for the identical
 * reason (nothing today reconciles or distinguishes between them), not a
 * fresh decision.
 *
 * Unlike expense categories, Salary Expense (and Salary Payable, reserved
 * for a future accrual-basis option) are both fixed seed accounts — no
 * auto-provisioning needed here.
 *
 * The narration is deliberately generic ("Staff salary payment — <period
 * label>"), never a staff name — mirrors `recordPayrollLedgerEntry`'s own
 * doc comment on why: `MANAGE_ACCOUNTING` (which will gate the new
 * accounting screens) is not paired with `VIEW_PAYROLL`, and this module
 * has no per-viewer redaction at read time, so the safe answer is keeping
 * the narration itself harmless to see rather than trying to filter it.
 */
export async function postPayrollVoucher(
  tx: Transaction,
  params: {
    restaurantId: string;
    branchId: string;
    payrollPaymentId: string;
    amountInPaisa: number;
    payPeriodLabel: string | null;
    paymentMethod: ExpensePaymentMethod;
    // Phase 5, Slice 5b — same meaning/rules as postExpenseVoucher's own
    // bankAccountId param (see that file's doc comment).
    bankAccountId?: string | null;
    timezone: string;
    createdByUserId: string;
  },
): Promise<void> {
  if (params.amountInPaisa <= 0) return;

  const clearingKey = PAYOUT_METHOD_MAPPING_KEYS[params.paymentMethod];
  const salaryExpenseAccounts = await resolveAccountMappings(tx, {
    restaurantId: params.restaurantId,
    keys: [MAPPING_KEYS.SALARY_EXPENSE],
  });
  const clearingAccountId =
    clearingKey === MAPPING_KEYS.BANK_DIGITAL_PAYMENTS
      ? await resolveBankAccountForPosting(tx, {
          restaurantId: params.restaurantId,
          requestedBankAccountId: params.bankAccountId,
          legacyMappingKey: MAPPING_KEYS.BANK_DIGITAL_PAYMENTS,
        })
      : (
          await resolveAccountMappings(tx, {
            restaurantId: params.restaurantId,
            keys: [clearingKey],
          })
        ).get(clearingKey)!;

  await postVoucher(tx, {
    restaurantId: params.restaurantId,
    branchId: params.branchId,
    voucherType: "payroll",
    voucherDate: restaurantDate(params.timezone),
    narration: params.payPeriodLabel
      ? `Staff salary payment — ${params.payPeriodLabel}`
      : "Staff salary payment",
    createdByUserId: params.createdByUserId,
    sourceType: "payroll_payout",
    sourceId: params.payrollPaymentId,
    postingEvent: "paid",
    lines: [
      { accountId: salaryExpenseAccounts.get(MAPPING_KEYS.SALARY_EXPENSE)!, debitInPaisa: params.amountInPaisa },
      { accountId: clearingAccountId, creditInPaisa: params.amountInPaisa },
    ],
  });
}

/**
 * Phase 4, Slice 4e — reverses a Payroll Voucher when the underlying
 * payment is voided. Unlike expenses, a payroll void is one-way (the
 * `[paymentId]` PATCH route only ever sets `isVoided: true` — there is no
 * un-void), so this is a plain single reversal, the same shape as
 * `reversePurchaseVoucher` (Slice 4c), not the reversal-chain walk expenses'
 * void/un-void toggle needed.
 *
 * A no-op if automatic posting wasn't enabled when this payment was
 * originally paid (no matching voucher to reverse) — checked by looking the
 * voucher up directly rather than re-checking `isAutomaticPostingEnabled`,
 * since what matters is whether THIS payment was posted, not whether
 * posting happens to be on right now.
 */
export async function reversePayrollVoucher(
  tx: Transaction,
  params: {
    restaurantId: string;
    payrollPaymentId: string;
    reason: string;
    reversedByUserId: string;
    timezone: string;
  },
): Promise<void> {
  const [original] = await tx
    .select({ id: accountingVouchers.id })
    .from(accountingVouchers)
    .where(
      and(
        eq(accountingVouchers.restaurantId, params.restaurantId),
        eq(accountingVouchers.sourceType, "payroll_payout"),
        eq(accountingVouchers.sourceId, params.payrollPaymentId),
        eq(accountingVouchers.postingEvent, "paid"),
      ),
    )
    .limit(1);
  if (!original) return;

  await reverseVoucher(tx, {
    restaurantId: params.restaurantId,
    voucherId: original.id,
    reason: params.reason,
    reversedByUserId: params.reversedByUserId,
    voucherDate: restaurantDate(params.timezone),
    allowClosedPeriod: true,
  });
}
