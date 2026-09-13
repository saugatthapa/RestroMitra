import "server-only";
import { and, eq } from "drizzle-orm";
import type { Transaction } from "@/db";
import { accountingVouchers } from "@/db/schema";
import { postVoucher, reverseVoucher } from "../post-voucher";
import { resolveAccountMappings } from "../account-mappings";
import { MAPPING_KEYS, type MappingKey } from "../account-mapping-keys";
import { restaurantDate } from "@/lib/restaurant-date";
import type { PaymentMethod } from "@/lib/payments";

// Only the three RECONCILABLE_PAYMENT_METHODS (financial-reconciliation.ts)
// ever reach this module — cash is structurally excluded before either
// caller below runs (assertReconcilableMethod throws first), matching
// ACCOUNTING_POLICY_AND_POSTING_MATRIX.md §9's own "cash never sits in a
// clearing account" reasoning.
const RECONCILABLE_METHOD_MAPPING_KEYS: Record<Exclude<PaymentMethod, "cash">, MappingKey> = {
  card: MAPPING_KEYS.PAYMENT_METHOD_CARD,
  mobile_wallet: MAPPING_KEYS.PAYMENT_METHOD_MOBILE_WALLET,
  other: MAPPING_KEYS.PAYMENT_METHOD_OTHER,
};

function isReconcilableMethod(method: PaymentMethod): method is Exclude<PaymentMethod, "cash"> {
  return method !== "cash";
}

async function findVoucherChainHead(tx: Transaction, restaurantId: string, paymentId: string) {
  const [original] = await tx
    .select({ id: accountingVouchers.id })
    .from(accountingVouchers)
    .where(
      and(
        eq(accountingVouchers.restaurantId, restaurantId),
        eq(accountingVouchers.sourceType, "payment_reconciliation"),
        eq(accountingVouchers.sourceId, paymentId),
        eq(accountingVouchers.postingEvent, "reconciled"),
      ),
    )
    .limit(1);
  if (!original) return null;

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
  return { original, head };
}

/**
 * Phase 4, Slice 4f — posts the reconciliation voucher when a card/
 * mobile_wallet/other payment is marked reconciled (a human confirmed it
 * against a real bank/gateway statement — see `markPaymentReconciled`'s own
 * doc comment). Per ACCOUNTING_POLICY_AND_POSTING_MATRIX.md §9: Dr the
 * (pulled-forward, minimal) Bank Account, Cr whichever clearing account
 * matches the payment's own method — the same clearing account that was
 * originally debited when the sale itself was posted (Slice 4a), now
 * zeroed out because the money has actually landed in the bank.
 *
 * Reconciliation can toggle — mark, unmark, re-mark, same as an expense's
 * void/un-void — so this is NOT simply "call postVoucher every time
 * markPaymentReconciled runs." The very first mark has no existing voucher
 * to work from and needs a real `postVoucher()` call. Every mark AFTER an
 * unmark is really "restore the previously-reversed voucher," which reuses
 * the exact same reversal-chain-walk `reverseOrRestoreReconciliationVoucher`
 * already implements for unmark itself — calling `postVoucher()` again here
 * would hit its own idempotency check on the (still-existing, but now
 * REVERSED) original voucher and silently replay that stale, reversed
 * voucher instead of restoring the posting, exactly the bug
 * `reverseOrRestoreExpenseVoucher` (Slice 4d) was designed to avoid.
 *
 * `markPaymentReconciled` itself already guards against calling this when a
 * voucher is already active (it throws "already marked reconciled" off
 * `payments.reconciledAt` before this ever runs), so the only two cases
 * reachable here are "never posted before" and "posted, then reversed by an
 * unmark" — never "posted and still active."
 */
export async function postReconciliationVoucher(
  tx: Transaction,
  params: {
    restaurantId: string;
    branchId: string;
    paymentId: string;
    amountInPaisa: number;
    method: PaymentMethod;
    timezone: string;
    createdByUserId: string;
  },
): Promise<void> {
  if (params.amountInPaisa <= 0) return;
  if (!isReconcilableMethod(params.method)) return;

  const chain = await findVoucherChainHead(tx, params.restaurantId, params.paymentId);
  if (chain) {
    // A re-mark after an unmark — restore by reversing the currently-active
    // reversal (flips its swapped lines back to the original direction).
    await reverseVoucher(tx, {
      restaurantId: params.restaurantId,
      voucherId: chain.head.id,
      reason: "Payment reconciliation restored",
      reversedByUserId: params.createdByUserId,
      voucherDate: restaurantDate(params.timezone),
      allowClosedPeriod: true,
    });
    return;
  }

  const clearingKey = RECONCILABLE_METHOD_MAPPING_KEYS[params.method];
  const accounts = await resolveAccountMappings(tx, {
    restaurantId: params.restaurantId,
    keys: [MAPPING_KEYS.BANK_ACCOUNT, clearingKey],
  });

  await postVoucher(tx, {
    restaurantId: params.restaurantId,
    branchId: params.branchId,
    voucherType: "contra",
    voucherDate: restaurantDate(params.timezone),
    narration: "Payment reconciled to bank",
    createdByUserId: params.createdByUserId,
    sourceType: "payment_reconciliation",
    sourceId: params.paymentId,
    postingEvent: "reconciled",
    lines: [
      { accountId: accounts.get(MAPPING_KEYS.BANK_ACCOUNT)!, debitInPaisa: params.amountInPaisa },
      { accountId: accounts.get(clearingKey)!, creditInPaisa: params.amountInPaisa },
    ],
  });
}

/**
 * Phase 4, Slice 4f — reverses the reconciliation voucher when a mark is
 * undone (`unmarkPaymentReconciled`). Same reversal-chain-walk shape as
 * `reverseOrRestoreExpenseVoucher` (Slice 4d): walks `reversalOfVoucherId`
 * forward from the original "reconciled" voucher to whichever voucher in
 * the chain is currently active, and reverses that one — correct across
 * unlimited mark/unmark cycles, never double-counting the bank movement.
 *
 * A no-op if no voucher was ever posted for this payment (automatic posting
 * wasn't enabled at the time it was originally marked reconciled, or the
 * method wasn't reconcilable in the first place — impossible in practice
 * since `assertReconcilableMethod` already rejects cash before this point).
 */
export async function reverseReconciliationVoucher(
  tx: Transaction,
  params: {
    restaurantId: string;
    paymentId: string;
    reversedByUserId: string;
    timezone: string;
  },
): Promise<void> {
  const chain = await findVoucherChainHead(tx, params.restaurantId, params.paymentId);
  if (!chain) return;

  await reverseVoucher(tx, {
    restaurantId: params.restaurantId,
    voucherId: chain.head.id,
    reason: "Payment reconciliation reversed",
    reversedByUserId: params.reversedByUserId,
    voucherDate: restaurantDate(params.timezone),
    allowClosedPeriod: true,
  });
}
