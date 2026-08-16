/**
 * All inventory quantities in DhankiPOS are stored and computed as integer
 * MILLIUNITS (a real quantity * 1000, i.e. 3 decimal places of precision)
 * — never as a float. Same reasoning as src/lib/money.ts uses for paisa:
 * floats cannot represent most decimal fractions exactly, which is exactly
 * the kind of error that must never happen in a stock ledger.
 *
 * These helpers are the only place formatting/parsing happens — route
 * handlers and UI code should go through them rather than doing ad hoc
 * `* 1000` / `/ 1000` math, so rounding behavior stays consistent
 * everywhere (matches the pattern money.ts already establishes).
 */

import type { InventoryUnit } from "./inventory-units";

export function milliunitsToUnits(milliunits: number): number {
  return milliunits / 1000;
}

export function unitsToMilliunits(units: number): number {
  // Round to the nearest milliunit rather than truncating, avoiding the
  // classic float-artifact problem (e.g. 2.5 * 1000 = 2499.999…).
  return Math.round(units * 1000);
}

const UNIT_LABELS: Record<InventoryUnit, string> = {
  g: "g",
  kg: "kg",
  ml: "ml",
  l: "L",
  piece: "pc",
  packet: "packet",
  dozen: "dozen",
};

/** Formats milliunits as a human-readable quantity, e.g. "2.5 kg", "12 pc". Trailing zeros after the decimal are trimmed. */
export function formatQuantity(milliunits: number, unit: InventoryUnit): string {
  const units = milliunitsToUnits(milliunits);
  // Up to 3 decimal places, but trimmed — "2.500" -> "2.5", "12.000" -> "12".
  const rounded = Math.round(units * 1000) / 1000;
  return `${rounded} ${UNIT_LABELS[unit]}`;
}
