/**
 * The fixed set of units of measure inventory items can be tracked in.
 * Dependency-free (no "server-only", no DB import) so it's shared,
 * unmodified, between Zod validation, API routes, and the dashboard UI —
 * same pattern as PAYMENT_METHODS in src/lib/payments.ts.
 *
 * Each inventory item has exactly ONE unit; there is no conversion between
 * units in this phase (see PHASE_7_NOTES.md).
 */

export const INVENTORY_UNITS = ["g", "kg", "ml", "l", "piece", "packet", "dozen"] as const;
export type InventoryUnit = (typeof INVENTORY_UNITS)[number];

export const INVENTORY_UNIT_LABELS: Record<InventoryUnit, string> = {
  g: "Grams (g)",
  kg: "Kilograms (kg)",
  ml: "Millilitres (ml)",
  l: "Litres (L)",
  piece: "Piece",
  packet: "Packet",
  dozen: "Dozen",
};
