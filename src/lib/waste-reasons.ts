/**
 * P2 — the fixed structured reason taxonomy for a "waste" stock movement
 * (src/db/schema.ts's wasteReasonEnum). Dependency-free (no "server-only",
 * no DB import) so it's shared, unmodified, between Zod validation, API
 * routes, and the dashboard UI — same pattern as INVENTORY_UNITS in
 * src/lib/inventory-units.ts.
 */

export const WASTE_REASONS = [
  "spoilage",
  "expired",
  "breakage",
  "overproduction",
  "theft_or_loss",
  "other",
] as const;
export type WasteReasonValue = (typeof WASTE_REASONS)[number];

export const WASTE_REASON_LABELS: Record<WasteReasonValue, string> = {
  spoilage: "Spoilage",
  expired: "Expired",
  breakage: "Breakage",
  overproduction: "Overproduction",
  theft_or_loss: "Theft / loss",
  other: "Other",
};
