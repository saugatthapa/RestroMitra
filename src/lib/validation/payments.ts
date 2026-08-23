import { z } from "zod";
import { rupeesToPaisa } from "@/lib/money";
import { PAYMENT_METHODS } from "@/lib/payments";
import { orderAdjustmentsInputSchema } from "@/lib/validation/order-adjustments";

const rupeeAmount = z
  .number()
  .positive("Amount must be greater than zero.")
  .max(10_000_000, "Amount is unreasonably large.")
  .transform((rupees) => rupeesToPaisa(rupees));

export const recordPaymentSchema = z.object({
  amount: rupeeAmount,
  method: z.enum(PAYMENT_METHODS),
  // Cash physically handed over, if different from `amount` (to show
  // change due). Only meaningful for method "cash"; ignored otherwise.
  receivedAmount: rupeeAmount.optional(),
  // Phase 13 — gratuity collected alongside this payment, in rupees.
  // Deliberately NOT validated against remaining due (see the tipInPaisa
  // column comment in schema.ts) — a tip is separate money for staff, not
  // part of the bill.
  tip: z
    .number()
    .min(0, "Tip cannot be negative.")
    .max(1_000_000, "Tip is unreasonably large.")
    .optional(),
  note: z.string().trim().max(300).optional().or(z.literal("")),
  // RC audit — a client-generated retry key identifying this exact
  // submission attempt, not the payment itself. Mirrors
  // createStaffOrderSchema's clientRequestId (see its comment): a retry of
  // the same submission (dropped response, offline-queue replay) must
  // return the original payment rather than double-insert it.
  clientRequestId: z.string().trim().min(1).max(100).optional(),
});

export const recordRefundSchema = z.object({
  amount: rupeeAmount,
  method: z.enum(PAYMENT_METHODS),
  reason: z.string().trim().max(300).optional().or(z.literal("")),
  refundOfPaymentId: z.string().uuid().optional(),
});

export const createStaffOrderSchema = z.object({
  tableId: z.string().uuid().nullable().optional(),
  // Only consulted for a table-less (takeaway) order — when a table is
  // given, its own branch always wins (see the route). Optional/nullable
  // for the same "resolve, don't trust" reasons as every other id here.
  branchId: z.string().uuid().nullable().optional(),
  items: z
    .array(
      z.object({
        menuItemId: z.string().uuid(),
        variantId: z.string().uuid().nullable().optional(),
        quantity: z.number().int().min(1).max(50),
        addonIds: z.array(z.string().uuid()).max(20).optional().default([]),
        notes: z.string().trim().max(300).optional(),
      }),
    )
    .min(1, "Add at least one item.")
    .max(40),
  customerName: z.string().trim().max(150).optional().or(z.literal("")),
  customerPhone: z.string().trim().max(20).optional().or(z.literal("")),
  // Optional link to a Phase 8 CRM customer record — see the orders.customerId
  // column comment in schema.ts. Verified server-side to belong to this
  // restaurant before being persisted (never trust a client-supplied id
  // alone), same pattern as tableId above.
  customerId: z.string().uuid().nullable().optional(),
  notes: z.string().trim().max(500).optional().or(z.literal("")),
  // Phase 11b (offline POS): a client-generated UUID identifying this exact
  // submission attempt, not the order itself. A staff device queues orders
  // locally while offline and retries the same POST once back online (or a
  // flaky connection just times out after the server already committed) —
  // resubmitting with the SAME clientRequestId must return the original
  // order rather than create a duplicate. See the orders route.
  clientRequestId: z.string().trim().min(1).max(100).optional(),
  // Phase 13 — optional at creation time; a discount/service charge set
  // here still requires the caller to hold APPLY_DISCOUNT (checked in the
  // route, since a Zod schema can't see the caller's permissions). Waiters
  // with only CREATE_ORDER simply never send this field from the POS UI.
  adjustments: orderAdjustmentsInputSchema.optional(),
  // Phase 17 — redeem this many of the attached customer's loyalty points
  // as a discount at checkout, instead of it only being a manual
  // Customers-page ledger action. Requires customerId to also be set
  // (checked in the route) and is mutually exclusive with `adjustments`
  // specifying its own discount — one discount slot per order (see
  // order-adjustments.ts), so a manual discount and a loyalty redemption
  // can't both apply to the same order. Gated behind MANAGE_CUSTOMERS in
  // the route, the same permission the manual redemption action on the
  // Customers page already requires — this is the customer's own earned
  // balance, not staff discretion, so it's not tied to APPLY_DISCOUNT.
  loyaltyRedemption: z
    .object({
      points: z.number().int().min(1),
    })
    .optional(),
});
