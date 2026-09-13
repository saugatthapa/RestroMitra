import "server-only";
import { and, eq } from "drizzle-orm";
import type { Transaction } from "@/db";
import { orderItems, payments } from "@/db/schema";
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
 * Phase 4, Slice 4a — posts the Sales Voucher (and, separately, the Cost of
 * Goods Sold voucher) for one order at the exact moment it's marked
 * completed, per ACCOUNTING_POLICY_AND_POSTING_MATRIX.md §1/§6. Called from
 * the order-status route's own `targetStatus === "completed"` block, inside
 * the SAME transaction as everything else that fires at that transition —
 * gated by the caller on `isAutomaticPostingEnabled()` first, so this
 * function is never even invoked for a restaurant that hasn't opted in.
 *
 * Correction to the matrix's own §1 wording, found while implementing this:
 * the matrix's table says the Dr clearing-account lines are "sum of those
 * payments' amountInPaisa," but that undercounts them by the tip portion —
 * a Rs 500 cash payment against a Rs 450 bill (Rs 50 tip) puts the FULL
 * Rs 500 physically in the drawer, not just Rs 450. The matrix's own
 * balancing proof directly below that table already assumes tips ARE
 * folded into the Dr clearing total ("total(Dr cash/clearing lines) + AR +
 * discount = subtotal + serviceCharge + tax + tips") — so this
 * implementation follows that proof, not the table cell's literal wording,
 * and ACCOUNTING_POLICY_AND_POSTING_MATRIX.md §1 has been corrected to
 * match. Verified balanced in accounting-integration-sales.test.ts.
 */
export async function postSaleAndCogsVouchers(
  tx: Transaction,
  params: {
    restaurantId: string;
    branchId: string;
    orderId: string;
    orderNumber: string;
    subtotalInPaisa: number;
    discountInPaisa: number;
    serviceChargeInPaisa: number;
    taxInPaisa: number;
    totalInPaisa: number;
    customerId: string | null;
    timezone: string;
    createdByUserId: string;
  },
): Promise<void> {
  // Mirrors recordSalesLedgerEntry's own free/zero-total no-op.
  if (params.totalInPaisa <= 0) return;

  const paymentRows = await tx
    .select({
      method: payments.method,
      amountInPaisa: payments.amountInPaisa,
      tipInPaisa: payments.tipInPaisa,
    })
    .from(payments)
    .where(and(eq(payments.orderId, params.orderId), eq(payments.restaurantId, params.restaurantId)));

  // Two separate running totals per method: the BILL portion (amountInPaisa
  // — what counts toward totalInPaisa/AR) and the full CLEARING amount
  // actually collected (amountInPaisa + tipInPaisa — what physically landed
  // in the till/gateway). A refund row (negative amountInPaisa, always
  // tipInPaisa: 0 — see the refunds route) nets both down correctly with no
  // special-casing.
  const billNetByMethod = new Map<PaymentMethod, number>();
  const clearingNetByMethod = new Map<PaymentMethod, number>();
  let tipTotalInPaisa = 0;
  for (const p of paymentRows) {
    billNetByMethod.set(p.method, (billNetByMethod.get(p.method) ?? 0) + p.amountInPaisa);
    clearingNetByMethod.set(
      p.method,
      (clearingNetByMethod.get(p.method) ?? 0) + p.amountInPaisa + p.tipInPaisa,
    );
    tipTotalInPaisa += p.tipInPaisa;
  }
  const billPaidTotalInPaisa = Array.from(billNetByMethod.values()).reduce((s, a) => s + a, 0);
  const receivableInPaisa = Math.max(0, params.totalInPaisa - billPaidTotalInPaisa);

  // Only methods that actually netted to a positive clearing amount get a
  // line — e.g. a payment fully offset by a same-method refund before
  // completion contributes no voucher line for money that isn't sitting
  // anywhere anymore.
  const activeMethods = Array.from(clearingNetByMethod.entries()).filter(([, amount]) => amount > 0);

  const mappingKeys: MappingKey[] = [MAPPING_KEYS.SALES_REVENUE];
  for (const [method] of activeMethods) mappingKeys.push(PAYMENT_METHOD_MAPPING_KEYS[method]);
  if (receivableInPaisa > 0) mappingKeys.push(MAPPING_KEYS.ACCOUNTS_RECEIVABLE);
  if (params.discountInPaisa > 0) mappingKeys.push(MAPPING_KEYS.DISCOUNTS_AND_ALLOWANCES);
  if (params.serviceChargeInPaisa > 0) mappingKeys.push(MAPPING_KEYS.SERVICE_CHARGE_REVENUE);
  if (params.taxInPaisa > 0) mappingKeys.push(MAPPING_KEYS.TAX_PAYABLE);
  if (tipTotalInPaisa > 0) mappingKeys.push(MAPPING_KEYS.TIPS_PAYABLE);

  const accounts = await resolveAccountMappings(tx, { restaurantId: params.restaurantId, keys: mappingKeys });
  const voucherDate = restaurantDate(params.timezone);

  const lines: PostVoucherLine[] = [];
  for (const [method, amount] of activeMethods) {
    lines.push({
      accountId: accounts.get(PAYMENT_METHOD_MAPPING_KEYS[method])!,
      debitInPaisa: amount,
      orderId: params.orderId,
    });
  }
  if (receivableInPaisa > 0) {
    lines.push({
      accountId: accounts.get(MAPPING_KEYS.ACCOUNTS_RECEIVABLE)!,
      debitInPaisa: receivableInPaisa,
      customerId: params.customerId,
      orderId: params.orderId,
    });
  }
  if (params.discountInPaisa > 0) {
    lines.push({
      accountId: accounts.get(MAPPING_KEYS.DISCOUNTS_AND_ALLOWANCES)!,
      debitInPaisa: params.discountInPaisa,
      orderId: params.orderId,
    });
  }
  lines.push({
    accountId: accounts.get(MAPPING_KEYS.SALES_REVENUE)!,
    creditInPaisa: params.subtotalInPaisa,
    orderId: params.orderId,
  });
  if (params.serviceChargeInPaisa > 0) {
    lines.push({
      accountId: accounts.get(MAPPING_KEYS.SERVICE_CHARGE_REVENUE)!,
      creditInPaisa: params.serviceChargeInPaisa,
      orderId: params.orderId,
    });
  }
  if (params.taxInPaisa > 0) {
    lines.push({
      accountId: accounts.get(MAPPING_KEYS.TAX_PAYABLE)!,
      creditInPaisa: params.taxInPaisa,
      orderId: params.orderId,
    });
  }
  if (tipTotalInPaisa > 0) {
    lines.push({
      accountId: accounts.get(MAPPING_KEYS.TIPS_PAYABLE)!,
      creditInPaisa: tipTotalInPaisa,
      orderId: params.orderId,
    });
  }

  await postVoucher(tx, {
    restaurantId: params.restaurantId,
    branchId: params.branchId,
    voucherType: "sales",
    voucherDate,
    narration: `Sale — order #${params.orderNumber}`,
    createdByUserId: params.createdByUserId,
    sourceType: "order_completion",
    sourceId: params.orderId,
    postingEvent: "sale",
    lines,
  });

  // COGS — same trigger/source, different posting_event (matrix §6). Items
  // with no recipe (recipeCostInPaisa left NULL by deductRecipeStockForOrder
  // — see that function's own comment) simply don't contribute, same
  // convention as getCogsSummary's reporting-side aggregation.
  const itemRows = await tx
    .select({ recipeCostInPaisa: orderItems.recipeCostInPaisa })
    .from(orderItems)
    .where(eq(orderItems.orderId, params.orderId));
  const cogsTotalInPaisa = itemRows.reduce((sum, r) => sum + (r.recipeCostInPaisa ?? 0), 0);

  if (cogsTotalInPaisa > 0) {
    const cogsAccounts = await resolveAccountMappings(tx, {
      restaurantId: params.restaurantId,
      keys: [MAPPING_KEYS.COST_OF_GOODS_SOLD, MAPPING_KEYS.INVENTORY],
    });
    await postVoucher(tx, {
      restaurantId: params.restaurantId,
      branchId: params.branchId,
      voucherType: "sales",
      voucherDate,
      narration: `Cost of goods sold — order #${params.orderNumber}`,
      createdByUserId: params.createdByUserId,
      sourceType: "order_completion",
      sourceId: params.orderId,
      postingEvent: "cogs",
      lines: [
        {
          accountId: cogsAccounts.get(MAPPING_KEYS.COST_OF_GOODS_SOLD)!,
          debitInPaisa: cogsTotalInPaisa,
          orderId: params.orderId,
        },
        {
          accountId: cogsAccounts.get(MAPPING_KEYS.INVENTORY)!,
          creditInPaisa: cogsTotalInPaisa,
          orderId: params.orderId,
        },
      ],
    });
  }
}
