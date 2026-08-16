import { z } from "zod";
import { rupeesToPaisa } from "@/lib/money";

// Accepts a rupee amount from the UI (e.g. 180 or 19.99) and converts to
// integer paisa at the validation boundary — paisa is the only unit that
// ever reaches the database or a calculation.
const rupeeAmount = z
  .number()
  .nonnegative("Price cannot be negative.")
  .max(10_000_000, "Price is unreasonably large.")
  .transform((rupees) => rupeesToPaisa(rupees));

const percentTax = z
  .number()
  .min(0, "Tax rate cannot be negative.")
  .max(100, "Tax rate cannot exceed 100%.")
  .transform((percent) => Math.round(percent * 100));

// Phase 15 — a menu item photo. Accepts either a normal http(s) image URL
// (the original design) or a data: URL (what MenuManager's client-side
// upload produces — it resizes/re-encodes the picked file through a canvas
// before it ever reaches this schema, so a data: URL here is always a
// flattened raster image, never raw uploaded bytes). The 2,000,000-char cap
// is well above what that client-side compression should ever produce
// (a few hundred KB of base64 at most) — it exists purely as a backstop
// against an oversized payload, not a target size.
const menuItemImageUrl = z
  .string()
  .trim()
  .max(2_000_000, "Image is too large.")
  .refine(
    (value) => value === "" || /^https?:\/\//i.test(value) || /^data:image\/(png|jpe?g|webp|gif);base64,/i.test(value),
    "Image must be an http(s) URL or an uploaded image.",
  );

export const createCategorySchema = z.object({
  name: z.string().trim().min(1, "Category name is required.").max(100),
});

export const updateCategorySchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  isActive: z.boolean().optional(),
});

export const reorderSchema = z.object({
  orderedIds: z.array(z.string().uuid()).min(1),
});

export const reorderItemsSchema = z.object({
  categoryId: z.string().uuid(),
  orderedIds: z.array(z.string().uuid()).min(1),
});

export const createKitchenStationSchema = z.object({
  name: z.string().trim().min(1, "Station name is required.").max(100),
});

export const createMenuItemSchema = z.object({
  categoryId: z.string().uuid(),
  kitchenStationId: z.string().uuid().nullable().optional(),
  name: z.string().trim().min(1, "Item name is required.").max(150),
  description: z.string().trim().max(2000).optional().or(z.literal("")),
  imageUrl: menuItemImageUrl.optional(),
  sku: z.string().trim().max(60).optional().or(z.literal("")),
  price: rupeeAmount,
  taxRatePercent: percentTax.optional().default(0),
  prepTimeMinutes: z.number().int().min(0).max(600).optional(),
  isAvailable: z.boolean().optional().default(true),
});

export const updateMenuItemSchema = z.object({
  categoryId: z.string().uuid().optional(),
  kitchenStationId: z.string().uuid().nullable().optional(),
  name: z.string().trim().min(1).max(150).optional(),
  description: z.string().trim().max(2000).optional().or(z.literal("")),
  imageUrl: menuItemImageUrl.optional(),
  sku: z.string().trim().max(60).optional().or(z.literal("")),
  price: rupeeAmount.optional(),
  taxRatePercent: percentTax.optional(),
  prepTimeMinutes: z.number().int().min(0).max(600).nullable().optional(),
  isAvailable: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

export const createVariantSchema = z.object({
  name: z.string().trim().min(1, "Variant name is required.").max(60),
  price: rupeeAmount,
});

export const updateVariantSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  price: rupeeAmount.optional(),
  isActive: z.boolean().optional(),
});

export const createAddonSchema = z.object({
  name: z.string().trim().min(1, "Add-on name is required.").max(100),
  price: rupeeAmount.optional().default(0),
});

export const updateAddonSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  price: rupeeAmount.optional(),
  isAvailable: z.boolean().optional(),
});
