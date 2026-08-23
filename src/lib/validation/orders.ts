import { z } from "zod";
import { ORDER_STATUSES } from "@/lib/order-status";

const cartItemSchema = z.object({
  menuItemId: z.string().uuid(),
  variantId: z.string().uuid().nullable().optional(),
  quantity: z.number().int().min(1).max(50),
  addonIds: z.array(z.string().uuid()).max(20).optional().default([]),
  notes: z.string().trim().max(300).optional(),
});

export const submitPublicOrderSchema = z.object({
  items: z.array(cartItemSchema).min(1, "Add at least one item to your order.").max(40),
  customerName: z.string().trim().max(150).optional().or(z.literal("")),
  customerPhone: z
    .string()
    .trim()
    .max(20)
    .regex(/^[0-9+\-\s]*$/, "Phone number contains invalid characters.")
    .optional()
    .or(z.literal("")),
  notes: z.string().trim().max(500).optional().or(z.literal("")),
  // P0-2 — same idempotency mechanism as the staff order route's
  // clientRequestId (see validation/payments.ts): a client-generated id
  // this specific submission attempt is tagged with, so a retry (a guest's
  // flaky mobile connection timing out after the order already committed,
  // or the QR menu's own double-submit guard racing a slow response) can
  // be recognized and handed back the original order instead of creating a
  // second one. This is the higher-risk gap this covers — the public QR
  // route has no staff oversight to catch a duplicate order the way a
  // busy counter might notice two identical tickets print.
  clientRequestId: z.string().trim().min(1).max(100).optional(),
});

export const updateOrderStatusSchema = z.object({
  status: z.enum(ORDER_STATUSES),
  reason: z.string().trim().max(300).optional(),
});
