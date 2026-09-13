import "server-only";
import { and, eq } from "drizzle-orm";
import type { Transaction } from "@/db";
import { accountingVouchers } from "@/db/schema";
import { postVoucher, reverseVoucher } from "../post-voucher";
import { resolveAccountMappings, resolveOrProvisionExpenseCategoryAccount } from "../account-mappings";
import { MAPPING_KEYS, type MappingKey } from "../account-mapping-keys";
import { restaurantDate } from "@/lib/restaurant-date";
import type { ExpensePaymentMethod } from "@/lib/finance/expense-payment-methods";

// See MAPPING_KEYS.BANK_DIGITAL_PAYMENTS' own comment for why four of these
// six methods collapse onto one shared account.
const EXPENSE_PAYMENT_METHOD_MAPPING_KEYS: Record<ExpensePaymentMethod, MappingKey> = {
  cash: MAPPING_KEYS.PAYMENT_METHOD_CASH,
  bank_transfer: MAPPING_KEYS.BANK_DIGITAL_PAYMENTS,
  esewa: MAPPING_KEYS.BANK_DIGITAL_PAYMENTS,
  khalti: MAPPING_KEYS.BANK_DIGITAL_PAYMENTS,
  mobile_banking: MAPPING_KEYS.BANK_DIGITAL_PAYMENTS,
  other: MAPPING_KEYS.PAYMENT_METHOD_OTHER,
};

export type AutoProvisionedAccount = { id: string; code: string; name: string };

/**
 * Phase 4, Slice 4d — posts the Expense Voucher at the exact moment an
 * expense becomes "paid" (direct-pay creation, or the two-step
 * approve-then-pay flow's own `pay` route — see both call sites' comments),
 * per ACCOUNTING_POLICY_AND_POSTING_MATRIX.md §5: Dr the category's own
 * expense account (auto-provisioned on first use — see
 * resolveOrProvisionExpenseCategoryAccount's own comment), Cr the mapped
 * clearing account for the payment method actually used.
 *
 * Returns the auto-provisioned account's details (or null if the category
 * was already mapped) so the calling route can record its own
 * `accounting.account_auto_created` audit-log entry AFTER the surrounding
 * transaction commits — matching this codebase's own "audit logs fire
 * post-commit" convention (recordAuditLog always writes through the
 * top-level `db` handle, not `tx`, so logging from inside this function
 * would claim an account exists even if the outer transaction later rolled
 * back for an unrelated reason).
 */
export async function postExpenseVoucher(
  tx: Transaction,
  params: {
    restaurantId: string;
    branchId: string;
    expenseId: string;
    categoryId: string;
    categoryName: string;
    amountInPaisa: number;
    paymentMethod: ExpensePaymentMethod;
    timezone: string;
    createdByUserId: string;
  },
): Promise<{ autoProvisionedAccount: AutoProvisionedAccount | null }> {
  if (params.amountInPaisa <= 0) return { autoProvisionedAccount: null };

  const { accountId: categoryAccountId, autoProvisioned } = await resolveOrProvisionExpenseCategoryAccount(tx, {
    restaurantId: params.restaurantId,
    categoryId: params.categoryId,
    categoryName: params.categoryName,
  });

  const clearingKey = EXPENSE_PAYMENT_METHOD_MAPPING_KEYS[params.paymentMethod];
  const clearingAccounts = await resolveAccountMappings(tx, {
    restaurantId: params.restaurantId,
    keys: [clearingKey],
  });

  await postVoucher(tx, {
    restaurantId: params.restaurantId,
    branchId: params.branchId,
    voucherType: "expense",
    voucherDate: restaurantDate(params.timezone),
    narration: `Expense paid — ${params.categoryName}`,
    createdByUserId: params.createdByUserId,
    sourceType: "expense_payment",
    sourceId: params.expenseId,
    postingEvent: "paid",
    lines: [
      { accountId: categoryAccountId, debitInPaisa: params.amountInPaisa },
      { accountId: clearingAccounts.get(clearingKey)!, creditInPaisa: params.amountInPaisa },
    ],
  });

  return { autoProvisionedAccount: autoProvisioned };
}

/**
 * Phase 4, Slice 4d — toggling an expense's `isVoided` flag calls this in
 * BOTH directions (void and un-void), since both reduce to the exact same
 * operation: reverse whichever voucher in this expense's own
 * original/reversal chain is currently active (i.e. not itself already
 * reversed).
 *
 * Void reverses the original "paid" voucher — the ledger-side mirror is
 * `reverseExpenseLedgerEntry`. Un-void doesn't re-post a brand-new "paid"
 * voucher the way `recordExpenseLedgerEntry` re-inserts a fresh ledger row
 * — sourceType/sourceId/postingEvent would collide with the (already
 * reversed) original and `postVoucher`'s idempotency check would just hand
 * back that stale voucher, posting nothing new. Instead, un-void reverses
 * the VOID'S OWN reversal voucher: reversing a reversal flips its swapped
 * lines back to the original direction, so the net effect across all three
 * vouchers (original + void-reversal + un-void-reversal) exactly reproduces
 * the original "paid" posting — without ever claiming the money left the
 * till twice. A second void-then-un-void cycle simply extends the same
 * chain by two more links; walking `reversalOfVoucherId` forward from the
 * original always finds whichever voucher is currently the active one to
 * flip next.
 *
 * A no-op if no voucher was ever posted for this expense (automatic
 * posting wasn't enabled at the time it was originally paid).
 */
export async function reverseOrRestoreExpenseVoucher(
  tx: Transaction,
  params: {
    restaurantId: string;
    expenseId: string;
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
        eq(accountingVouchers.sourceType, "expense_payment"),
        eq(accountingVouchers.sourceId, params.expenseId),
        eq(accountingVouchers.postingEvent, "paid"),
      ),
    )
    .limit(1);
  if (!original) return;

  let head = original;
  for (let i = 0; i < 50; i++) {
    const [next] = await tx
      .select({ id: accountingVouchers.id })
      .from(accountingVouchers)
      .where(eq(accountingVouchers.reversalOfVoucherId, head.id))
      .limit(1);
    if (!next) break;
    head = next;
  }

  await reverseVoucher(tx, {
    restaurantId: params.restaurantId,
    voucherId: head.id,
    reason: params.reason,
    reversedByUserId: params.reversedByUserId,
    voucherDate: restaurantDate(params.timezone),
    allowClosedPeriod: true,
  });
}
