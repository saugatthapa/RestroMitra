import "server-only";
import { and, eq } from "drizzle-orm";
import type { Transaction } from "@/db";
import { accountingVouchers } from "@/db/schema";
import { postVoucher, reverseVoucher, type PostVoucherLine } from "../post-voucher";
import { resolveAccountMappings } from "../account-mappings";
import { MAPPING_KEYS } from "../account-mapping-keys";
import { restaurantDate } from "@/lib/restaurant-date";

/**
 * Phase 4, Slice 4c — posts the Purchase Voucher (stock-in from a supplier)
 * per ACCOUNTING_POLICY_AND_POSTING_MATRIX.md §4. Called from the purchases
 * route right after the existing `recordPurchaseLedgerEntry` call, same
 * transaction — additive, not a replacement.
 *
 * Open decision #5 (ACCOUNTING_PHASE_4_PLAN.md Part 5): an immediate
 * (non-credit) purchase has no payment-method field at all today — only
 * `isCredit` — so there's no way to know whether it was paid from the till
 * or by bank transfer. Per the plan's approved recommendation, every
 * immediate purchase defaults to the Cash on Hand account (the same account
 * `payment_method:cash` resolves to) until a real payment-method field
 * exists alongside Bank Accounts (Phase 5).
 *
 * Phase 6, Slice 6a — `vatInPaisa` is an optional, ADDITIVE third line: per
 * sign-off, VAT a VAT-registered supplier charged is on TOP of
 * `totalInPaisa` (the goods/service cost, still exactly what the line
 * items sum to and still exactly what Inventory is debited for — untouched
 * by this slice), not carved out of it. So a VAT-inclusive purchase debits
 * Inventory for the goods cost, debits "1150 Input VAT Receivable" for the
 * VAT, and credits Accounts Payable/Cash for the TRUE total actually owed
 * (`totalInPaisa + vatInPaisa`) — the voucher still balances by
 * construction, the same as every other slice's optional-line pattern
 * (Slice 5e's interest line, Slice 5d's disposal gain/loss line).
 */
export async function postPurchaseVoucher(
  tx: Transaction,
  params: {
    restaurantId: string;
    branchId: string;
    purchaseId: string;
    totalInPaisa: number;
    isCredit: boolean;
    supplierId: string | null;
    timezone: string;
    createdByUserId: string;
    vatInPaisa?: number | null;
  },
): Promise<void> {
  // Mirrors recordPurchaseLedgerEntry's own zero-total no-op.
  if (params.totalInPaisa <= 0) return;

  const vatInPaisa = params.vatInPaisa ?? 0;
  const owedInPaisa = params.totalInPaisa + vatInPaisa;

  const creditKey = params.isCredit ? MAPPING_KEYS.ACCOUNTS_PAYABLE : MAPPING_KEYS.PAYMENT_METHOD_CASH;
  const keys = vatInPaisa > 0 ? [MAPPING_KEYS.INVENTORY, MAPPING_KEYS.INPUT_VAT, creditKey] : [MAPPING_KEYS.INVENTORY, creditKey];
  const accounts = await resolveAccountMappings(tx, {
    restaurantId: params.restaurantId,
    keys,
  });

  const lines: PostVoucherLine[] = [{ accountId: accounts.get(MAPPING_KEYS.INVENTORY)!, debitInPaisa: params.totalInPaisa }];
  if (vatInPaisa > 0) {
    lines.push({ accountId: accounts.get(MAPPING_KEYS.INPUT_VAT)!, debitInPaisa: vatInPaisa });
  }
  lines.push(
    params.isCredit
      ? { accountId: accounts.get(creditKey)!, creditInPaisa: owedInPaisa, supplierId: params.supplierId }
      : { accountId: accounts.get(creditKey)!, creditInPaisa: owedInPaisa },
  );

  await postVoucher(tx, {
    restaurantId: params.restaurantId,
    branchId: params.branchId,
    voucherType: "purchase",
    voucherDate: restaurantDate(params.timezone),
    narration: vatInPaisa > 0 ? "Stock purchase (incl. input VAT)" : "Stock purchase",
    createdByUserId: params.createdByUserId,
    sourceType: "purchase",
    sourceId: params.purchaseId,
    postingEvent: "purchase",
    lines,
  });
}

/**
 * Phase 4, Slice 4c — reverses a Purchase Voucher when the underlying
 * purchase is voided. Not explicitly called out in the plan's own Slice 4c
 * write-up (which only lists creation), but a genuine gap the same
 * reasoning as Slices 4d/4e's void handling closes: `voidPurchase` already
 * reverses the stock movement and the linked Account Books ledger due (see
 * its own doc comment in supplier-dues.ts) — leaving this voucher standing
 * would permanently overstate Inventory and Accounts Payable/Cash by the
 * voided amount, with no way back short of a manual Journal Voucher. Safe
 * to always fully reverse: `voidPurchase` already refuses to void a
 * purchase once any payment has been recorded against it
 * (`ledgerEntry.settledAmountInPaisa > 0`), so there is never a partial-
 * settlement case to reconcile against.
 *
 * A no-op if automatic posting wasn't enabled at the time this purchase was
 * originally posted (no matching voucher to reverse) — checked by looking
 * the voucher up directly, not by re-checking `isAutomaticPostingEnabled`,
 * since what matters here is whether THIS purchase was posted, not whether
 * posting happens to be on right now.
 */
export async function reversePurchaseVoucher(
  tx: Transaction,
  params: {
    restaurantId: string;
    purchaseId: string;
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
        eq(accountingVouchers.sourceType, "purchase"),
        eq(accountingVouchers.sourceId, params.purchaseId),
        eq(accountingVouchers.postingEvent, "purchase"),
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

/**
 * Phase 4, Slice 4c — posts a due-settlement voucher for the generic,
 * single-entry `/ledger/[entryId]/settle` route, which (per
 * ACCOUNTING_PHASE_4_PLAN.md's own note) settles either a supplier due
 * (`referenceType: "purchase"`) or a customer/order due
 * (`referenceType: "order"`) through the same `settleLedgerDue` call —
 * Account Books has always treated these as one generic "on credit, settle"
 * mechanism. Mirrors §2/§4's settlement rows: whichever side isn't the
 * control account (Accounts Payable/Receivable) defaults to Cash on Hand,
 * same reasoning and same open decision as `postPurchaseVoucher` above,
 * since this generic settle flow has no payment-method field either.
 *
 * Every other referenceType never reaches `dueStatus: "outstanding"` in the
 * first place (expenses/payroll never call `recordLedgerEntry` with
 * `markAsDue`, and `recordSupplierAdjustment` deliberately doesn't either —
 * see its own comment) so this only ever needs to handle these two; a third
 * case is a no-op rather than a thrown error, so a future ledger category
 * that starts using `markAsDue` fails safe (settlement still succeeds,
 * simply without an accounting posting) instead of blocking the settlement
 * itself.
 */
export async function postLedgerDueSettlementVoucher(
  tx: Transaction,
  params: {
    restaurantId: string;
    branchId: string;
    referenceType: string;
    settlementEntryId: string;
    supplierId: string | null;
    customerId: string | null;
    amountInPaisa: number;
    timezone: string;
    createdByUserId: string;
  },
): Promise<void> {
  if (params.amountInPaisa <= 0) return;

  if (params.referenceType === "purchase") {
    const accounts = await resolveAccountMappings(tx, {
      restaurantId: params.restaurantId,
      keys: [MAPPING_KEYS.ACCOUNTS_PAYABLE, MAPPING_KEYS.PAYMENT_METHOD_CASH],
    });
    await postVoucher(tx, {
      restaurantId: params.restaurantId,
      branchId: params.branchId,
      voucherType: "purchase",
      voucherDate: restaurantDate(params.timezone),
      narration: "Supplier due settled",
      createdByUserId: params.createdByUserId,
      sourceType: "ledger_due_settlement",
      sourceId: params.settlementEntryId,
      postingEvent: "settled",
      lines: [
        {
          accountId: accounts.get(MAPPING_KEYS.ACCOUNTS_PAYABLE)!,
          debitInPaisa: params.amountInPaisa,
          supplierId: params.supplierId,
        },
        { accountId: accounts.get(MAPPING_KEYS.PAYMENT_METHOD_CASH)!, creditInPaisa: params.amountInPaisa },
      ],
    });
    return;
  }

  if (params.referenceType === "order") {
    const accounts = await resolveAccountMappings(tx, {
      restaurantId: params.restaurantId,
      keys: [MAPPING_KEYS.ACCOUNTS_RECEIVABLE, MAPPING_KEYS.PAYMENT_METHOD_CASH],
    });
    await postVoucher(tx, {
      restaurantId: params.restaurantId,
      branchId: params.branchId,
      voucherType: "payment",
      voucherDate: restaurantDate(params.timezone),
      narration: "Customer due settled",
      createdByUserId: params.createdByUserId,
      sourceType: "ledger_due_settlement",
      sourceId: params.settlementEntryId,
      postingEvent: "settled",
      lines: [
        { accountId: accounts.get(MAPPING_KEYS.PAYMENT_METHOD_CASH)!, debitInPaisa: params.amountInPaisa },
        {
          accountId: accounts.get(MAPPING_KEYS.ACCOUNTS_RECEIVABLE)!,
          creditInPaisa: params.amountInPaisa,
          customerId: params.customerId,
        },
      ],
    });
  }
}

/**
 * Phase 4, Slice 4c — posts one voucher for a lump-sum supplier payment
 * (`recordSupplierPayment`, the Supplier Statement page's own "record
 * payment" action), which can settle several underlying purchase ledger
 * entries in one call. Per the plan's own note: the accounting mirror is
 * ONE voucher for the total amount actually applied, not one per underlying
 * ledger entry — AP aging in this module comes from
 * `accounting_voucher_lines.supplier_id` tags directly, not from mirroring
 * `ledger_entries`' row shape one-to-one. `sourceId` is the id of the first
 * settlement's own ledger entry — there's no other natural id for "this
 * lump-sum payment event" since it isn't stored as its own row (same as the
 * underlying `ledger_entries` writes themselves, which have no idempotency
 * key on this route either — a retried request settles again either way;
 * this voucher simply mirrors whatever was actually settled).
 */
export async function postSupplierPaymentVoucher(
  tx: Transaction,
  params: {
    restaurantId: string;
    branchId: string;
    supplierId: string;
    firstSettlementEntryId: string;
    appliedInPaisa: number;
    timezone: string;
    createdByUserId: string;
  },
): Promise<void> {
  if (params.appliedInPaisa <= 0) return;

  const accounts = await resolveAccountMappings(tx, {
    restaurantId: params.restaurantId,
    keys: [MAPPING_KEYS.ACCOUNTS_PAYABLE, MAPPING_KEYS.PAYMENT_METHOD_CASH],
  });

  await postVoucher(tx, {
    restaurantId: params.restaurantId,
    branchId: params.branchId,
    voucherType: "purchase",
    voucherDate: restaurantDate(params.timezone),
    narration: "Supplier payment (lump sum)",
    createdByUserId: params.createdByUserId,
    sourceType: "supplier_payment",
    sourceId: params.firstSettlementEntryId,
    postingEvent: "settled",
    lines: [
      {
        accountId: accounts.get(MAPPING_KEYS.ACCOUNTS_PAYABLE)!,
        debitInPaisa: params.appliedInPaisa,
        supplierId: params.supplierId,
      },
      { accountId: accounts.get(MAPPING_KEYS.PAYMENT_METHOD_CASH)!, creditInPaisa: params.appliedInPaisa },
    ],
  });
}

/**
 * Phase 4, Slice 4c — the AR mirror of `postSupplierPaymentVoucher`, for
 * `settleCustomerCredit` (the Customers page's own lump-sum "record
 * payment" action against a customer's tab). Same one-voucher-per-call
 * reasoning.
 */
export async function postCustomerCreditSettlementVoucher(
  tx: Transaction,
  params: {
    restaurantId: string;
    branchId: string;
    customerId: string;
    firstSettlementEntryId: string;
    appliedInPaisa: number;
    timezone: string;
    createdByUserId: string;
  },
): Promise<void> {
  if (params.appliedInPaisa <= 0) return;

  const accounts = await resolveAccountMappings(tx, {
    restaurantId: params.restaurantId,
    keys: [MAPPING_KEYS.ACCOUNTS_RECEIVABLE, MAPPING_KEYS.PAYMENT_METHOD_CASH],
  });

  await postVoucher(tx, {
    restaurantId: params.restaurantId,
    branchId: params.branchId,
    voucherType: "payment",
    voucherDate: restaurantDate(params.timezone),
    narration: "Customer credit settled (lump sum)",
    createdByUserId: params.createdByUserId,
    sourceType: "customer_credit_settlement",
    sourceId: params.firstSettlementEntryId,
    postingEvent: "settled",
    lines: [
      { accountId: accounts.get(MAPPING_KEYS.PAYMENT_METHOD_CASH)!, debitInPaisa: params.appliedInPaisa },
      {
        accountId: accounts.get(MAPPING_KEYS.ACCOUNTS_RECEIVABLE)!,
        creditInPaisa: params.appliedInPaisa,
        customerId: params.customerId,
      },
    ],
  });
}
