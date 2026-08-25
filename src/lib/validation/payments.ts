import { z } from "zod";
import { rupeesToPaisa } from "@/lib/money";
import { PAYMENT_METHODS } from "@/lib/payments";
import { orderAdjustmentsInputSchema } from "@/lib/validation/order-adjustments";

// Commercial Launch Phase A.8 — cash is excluded at the query-param/lib
// layer (see financial-reconciliation.ts's assertReconcilableMethod), not
// here, so an invalid value still gets a clean Zod 400 rather than a
// method-specific error message from a query-string parse.
const RECONCILABLE_METHODS = ["card", "mobile_wallet", "other"] as const;

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
  // Commercial Launch Phase B.9 — Split Bill. Optional: tags this payment
  // as covering one payer's share (see orderBillSplits in schema.ts).
  // Validated to belong to THIS order in the route (resolve, don't
  // trust) — never consulted for the overpayment check, which still
  // compares against the order's own remaining due, not the split's.
  splitId: z.string().uuid().optional(),
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
  // Commercial Launch Phase B.8 — Combos allow an order made up ENTIRELY of
  // combo lines (e.g. "2x Family Meal" and nothing else), so `items` alone
  // can no longer require at least one entry — the combined
  // items+combos.refine below is what actually enforces "the cart isn't
  // empty".
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
    .max(40)
    .default([]),
  // Commercial Launch Phase B.8 — Combos. Each entry names a menuCombos row
  // and how many bundles to add; see computeComboPricing in
  // src/lib/combos.ts for how it explodes into order items.
  combos: z
    .array(
      z.object({
        comboId: z.string().uuid(),
        quantity: z.number().int().min(1).max(50),
      }),
    )
    .max(10)
    .default([]),
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
})
  // Commercial Launch Phase B.8 — the cart-emptiness check moved here from
  // `items`'s own .min(1) once combos made an all-combo order valid.
  .refine((d) => d.items.length > 0 || d.combos.length > 0, {
    message: "Add at least one item.",
    path: ["items"],
  });

// Commercial Launch Phase A.8 — Financial Reconciliation.
// from/to accept either a bare date ("2026-08-01") or a full ISO timestamp
// — parsed with `new Date(...)` in financial-reconciliation.ts, which
// handles both. Validated here only as "a string `new Date` can parse",
// not against a stricter datetime() format, since a bare date is the more
// natural thing for a human picking a date range.
const dateOrDatetime = z
  .string()
  .refine((v) => !Number.isNaN(new Date(v).getTime()), "Invalid date.");

export const reconciliationQuerySchema = z.object({
  branchId: z.string().uuid().optional(),
  method: z.enum(RECONCILABLE_METHODS).optional(),
  from: dateOrDatetime.optional(),
  to: dateOrDatetime.optional(),
  status: z.enum(["unreconciled", "reconciled", "all"]).optional(),
});
