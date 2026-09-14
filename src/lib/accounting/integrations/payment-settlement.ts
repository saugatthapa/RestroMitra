import "server-only";
import type { Transaction } from "@/db";
import { postVoucher, type PostVoucherLine } from "../post-voucher";
import { resolveAccountMappings } from "../account-mappings";
import { MAPPING_KEYS, type MappingKey } from "../account-mapping-keys";
import { restaurantDate } from "@/lib/restaurant-date";
import type { PaymentMethod } from "@/lib/payments";

const PAYMENT_METHOD_MAPPING_KEYS: Record<PaymentMethod, MappingKey> = {
  cash: MAPPING_KEYS.PAYMENT_METHOD_CASH,
  card: MAPPING_KEYS.PAYMENT_METHOD_CARD,
  mobile_wallet: MAPPING_KEYS.PAYMENT_METHOD_MOBILE_WALLET,
  other: MAPPING_KEYS.PAYMENT_METHOD_OTHER,
};

/**
 * Phase 4, Slice 4b — posts an Accounts Receivable settlement voucher when
 * a payment is recorded against an order that is ALREADY completed. Per
 * ACCOUNTING_POLICY_AND_POSTING_MATRIX.md §2: an order's full revenue is
 * recognized once, at completion (Slice 4a's Sales Voucher), with any
 * unpaid remainder going to Accounts Receivable — so a LATER payment
 * against that same order isn't new revenue, it's the customer paying down
 * that AR balance. A payment recorded BEFORE completion is not a
 * settlement at all — it's simply one of the payments Slice 4a's own Sales
 * Voucher sums up when the order completes — so the caller must only
 * invoke this when `order.status === "completed"` at the moment the
 * payment is recorded (checked by the route, not this function, to keep
 * the "when does this apply" decision next to the order status it reads).
 *
 * Tip amount is NOT included in the AR credit — a tip was never part of
 * totalInPaisa/Accounts Receivable in the first place (see Slice 4a's own
 * note) — but IS included in the clearing-account debit, for the same
 * "the till physically receives it" reason as Slice 4a. If the payment
 * carries a tip with zero bill amount (an edge case — tipping with no
 * remaining balance due), only the tip posts, straight to Tips Payable.
 */
export async function postPaymentSettlementVoucher(
  tx: Transaction,
  params: {
    restaurantId: string;
    branchId: string;
    orderId: string;
    paymentId: string;
    method: PaymentMethod;
    amountInPaisa: number;
    tipInPaisa: number;
    customerId: string | null;
    timezone: string;
    createdByUserId: string;
  },
): Promise<void> {
  const clearingTotalInPaisa = params.amountInPaisa + params.tipInPaisa;
  if (clearingTotalInPaisa <= 0) return;

  const mappingKeys = [PAYMENT_METHOD_MAPPING_KEYS[params.method]];
  if (params.amountInPaisa > 0) mappingKeys.push(MAPPING_KEYS.ACCOUNTS_RECEIVABLE);
  if (params.tipInPaisa > 0) mappingKeys.push(MAPPING_KEYS.TIPS_PAYABLE);

  const accounts = await resolveAccountMappings(tx, { restaurantId: params.restaurantId, keys: mappingKeys });

  const lines: PostVoucherLine[] = [
    {
      accountId: accounts.get(PAYMENT_METHOD_MAPPING_KEYS[params.method])!,
      debitInPaisa: clearingTotalInPaisa,
      orderId: params.orderId,
    },
  ];
  if (params.amountInPaisa > 0) {
    lines.push({
      accountId: accounts.get(MAPPING_KEYS.ACCOUNTS_RECEIVABLE)!,
      creditInPaisa: params.amountInPaisa,
      customerId: params.customerId,
      orderId: params.orderId,
    });
  }
  if (params.tipInPaisa > 0) {
    lines.push({
      accountId: accounts.get(MAPPING_KEYS.TIPS_PAYABLE)!,
      creditInPaisa: params.tipInPaisa,
      orderId: params.orderId,
    });
  }

  await postVoucher(tx, {
    restaurantId: params.restaurantId,
    branchId: params.branchId,
    voucherType: "payment",
    voucherDate: restaurantDate(params.timezone),
    narration: "Payment received against a completed order",
    createdByUserId: params.createdByUserId,
    sourceType: "payment_settlement",
    sourceId: params.paymentId,
    postingEvent: "settlement",
    lines,
  });
}

/**
 * Phase 4, Slice 4b — posts a refund voucher. Per §2: the full refund
 * amount books to Sales Returns & Refunds (never split against Tips
 * Payable) — see ACCOUNTING_PHASE_4_PLAN.md Slice 4b's own note on why:
 * today's `payments`/refund schema has no field distinguishing "of this
 * refund, this much was tip," so splitting it would mean guessing rather
 * than reading real data. Unconditional on order status — a refund can
 * legitimately happen well after an order completed.
 *
 * Phase 6, Slice 6d — per sign-off, `orderTaxInPaisa`/`orderTotalInPaisa`
 * (the ORIGINAL order's own recorded figures, unrelated to how much of it
 * has been refunded before) let this now reduce the original invoice's own
 * Output VAT correctly, not just its cash-flow side, closing the gap
 * Slice 6c's own VAT return report flagged: the refund is prorated by the
 * order's own blended tax-to-total ratio
 * (`taxPortion = round(amountInPaisa * orderTaxInPaisa / orderTotalInPaisa)`),
 * which is EXACT whenever the order's own items share one tax rate (the
 * common flat-VAT-menu case, and always exact for a full-order refund),
 * and an approximation only for an order that genuinely mixes taxable and
 * tax-exempt items — there is no per-item link on a refund today to do
 * better than that (see this function's own scope note in
 * ACCOUNTING_PHASE_6_SLICE_6D_REPORT.md). A tax-free order
 * (`orderTaxInPaisa === 0`) reduces to exactly today's pre-6d behavior —
 * the full amount still goes entirely to Sales Returns & Refunds.
 */
export async function postRefundVoucher(
  tx: Transaction,
  params: {
    restaurantId: string;
    branchId: string;
    orderId: string;
    refundPaymentId: string;
    method: PaymentMethod;
    amountInPaisa: number; // positive — the amount refunded, not payments.amountInPaisa's negative sign
    orderTaxInPaisa: number;
    orderTotalInPaisa: number;
    timezone: string;
    createdByUserId: string;
  },
): Promise<void> {
  if (params.amountInPaisa <= 0) return;

  const taxPortionInPaisa =
    params.orderTaxInPaisa > 0 && params.orderTotalInPaisa > 0
      ? Math.min(
          params.amountInPaisa,
          Math.round((params.amountInPaisa * params.orderTaxInPaisa) / params.orderTotalInPaisa),
        )
      : 0;
  const goodsPortionInPaisa = params.amountInPaisa - taxPortionInPaisa;

  const keys: MappingKey[] = [PAYMENT_METHOD_MAPPING_KEYS[params.method]];
  if (goodsPortionInPaisa > 0) keys.push(MAPPING_KEYS.SALES_RETURNS_AND_REFUNDS);
  if (taxPortionInPaisa > 0) keys.push(MAPPING_KEYS.TAX_PAYABLE);
  const accounts = await resolveAccountMappings(tx, { restaurantId: params.restaurantId, keys });

  const lines: PostVoucherLine[] = [];
  if (goodsPortionInPaisa > 0) {
    lines.push({
      accountId: accounts.get(MAPPING_KEYS.SALES_RETURNS_AND_REFUNDS)!,
      debitInPaisa: goodsPortionInPaisa,
      orderId: params.orderId,
    });
  }
  if (taxPortionInPaisa > 0) {
    lines.push({
      accountId: accounts.get(MAPPING_KEYS.TAX_PAYABLE)!,
      debitInPaisa: taxPortionInPaisa,
      orderId: params.orderId,
    });
  }
  lines.push({
    accountId: accounts.get(PAYMENT_METHOD_MAPPING_KEYS[params.method])!,
    creditInPaisa: params.amountInPaisa,
    orderId: params.orderId,
  });

  await postVoucher(tx, {
    restaurantId: params.restaurantId,
    branchId: params.branchId,
    voucherType: "refund",
    voucherDate: restaurantDate(params.timezone),
    narration: taxPortionInPaisa > 0 ? "Refund issued (credit note — reduces output VAT)" : "Refund issued",
    createdByUserId: params.createdByUserId,
    sourceType: "refund",
    sourceId: params.refundPaymentId,
    postingEvent: "refund",
    lines,
  });
}
