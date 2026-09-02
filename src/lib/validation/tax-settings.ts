import { z } from "zod";

/**
 * Gap-audit P2 fix (fiscal compliance) — the restaurant's PAN/VAT
 * registration numbers, editable from the tax-settings panel (see
 * FiscalSettingsPanel.tsx) and printed on the customer-facing bill
 * (OrderBillView.tsx) once set. Same "empty string clears the override"
 * convention as updateKotSettingsSchema (kot-settings.ts) — an owner
 * clearing the field back out is a legitimate edit, not a validation
 * error. Nepal PAN/VAT registration numbers are 9 digits in practice, but
 * this deliberately doesn't enforce that format: older paper-era
 * registrations, and the field's actual real-world use as free text on a
 * receipt, make a hard format check more likely to block a legitimate
 * value than to catch a mistake.
 */
export const updateTaxSettingsSchema = z.object({
  panNumber: z.string().trim().max(20).optional().or(z.literal("")),
  vatNumber: z.string().trim().max(20).optional().or(z.literal("")),
});
