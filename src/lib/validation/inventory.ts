import { z } from "zod";
import { rupeesToPaisa } from "@/lib/money";
import { unitsToMilliunits } from "@/lib/quantity";
import { INVENTORY_UNITS } from "@/lib/inventory-units";

const rupeeAmount = z
  .number()
  .positive("Amount must be greater than zero.")
  .max(10_000_000, "Amount is unreasonably large.")
  .transform((rupees) => rupeesToPaisa(rupees));

/** A physical quantity in the item's own unit (e.g. "2.5" for 2.5 kg), converted to milliunits. */
const quantityAmount = z
  .number()
  .positive("Quantity must be greater than zero.")
  .max(1_000_000, "Quantity is unreasonably large.")
  .transform((units) => unitsToMilliunits(units));

/** A reorder threshold — unlike quantityAmount, zero and null (no alerting) are both valid. */
const reorderLevel = z.number().nonnegative().max(1_000_000).nullable().optional();

export const createSupplierSchema = z.object({
  name: z.string().trim().min(1, "Supplier name is required.").max(150),
  phone: z.string().trim().max(20).optional().or(z.literal("")),
  address: z.string().trim().max(500).optional().or(z.literal("")),
  notes: z.string().trim().max(1000).optional().or(z.literal("")),
});

export const updateSupplierSchema = z.object({
  name: z.string().trim().min(1).max(150).optional(),
  phone: z.string().trim().max(20).optional().or(z.literal("")),
  address: z.string().trim().max(500).optional().or(z.literal("")),
  notes: z.string().trim().max(1000).optional().or(z.literal("")),
  isActive: z.boolean().optional(),
});

// Deliberately no "initial stock" field here — an inventory item always
// starts at zero stock. Recording existing stock on hand is a manual
// "adjustment" (recordStockAdjustmentSchema below) right after creation,
// so every unit of stock is traceable to a ledger entry, never silently
// materialized by the create form.
export const createInventoryItemSchema = z.object({
  name: z.string().trim().min(1, "Item name is required.").max(150),
  unit: z.enum(INVENTORY_UNITS),
  reorderLevel,
  preferredSupplierId: z.string().uuid().nullable().optional(),
});

export const updateInventoryItemSchema = z.object({
  name: z.string().trim().min(1).max(150).optional(),
  unit: z.enum(INVENTORY_UNITS).optional(),
  reorderLevel,
  preferredSupplierId: z.string().uuid().nullable().optional(),
  isActive: z.boolean().optional(),
});

export const recordStockAdjustmentSchema = z.object({
  quantity: quantityAmount,
  direction: z.enum(["add", "remove"]),
  reason: z.string().trim().min(1, "A reason is required.").max(300),
});

export const createPurchaseSchema = z.object({
  supplierId: z.string().uuid().nullable().optional(),
  invoiceNumber: z.string().trim().max(60).optional().or(z.literal("")),
  notes: z.string().trim().max(1000).optional().or(z.literal("")),
  items: z
    .array(
      z.object({
        inventoryItemId: z.string().uuid(),
        quantity: quantityAmount,
        // Cost per ONE WHOLE UNIT (e.g. per kg), in rupees — matches
        // inventoryItems.costPerUnitInPaisa's own unit basis.
        unitCost: rupeeAmount,
      }),
    )
    .min(1, "Add at least one line item.")
    .max(100),
});

export const replaceRecipeSchema = z.object({
  items: z
    .array(
      z.object({
        inventoryItemId: z.string().uuid(),
        quantityPerServing: quantityAmount,
      }),
    )
    .max(50)
    .default([])
    .refine(
      (items) => new Set(items.map((i) => i.inventoryItemId)).size === items.length,
      "Each ingredient can only appear once in a recipe.",
    ),
});
