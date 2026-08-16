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
});

export const updateOrderStatusSchema = z.object({
  status: z.enum(ORDER_STATUSES),
  reason: z.string().trim().max(300).optional(),
});
