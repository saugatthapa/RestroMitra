import { z } from "zod";

/**
 * Phase 17 — the Kitchen Order Ticket header text, editable from the KDS
 * page (see KotSettingsPanel.tsx). An empty string clears the override and
 * falls back to the restaurant's legal name at render time
 * (resolveKotHeaderText in kot-ticket.ts) — same "empty means unset, not
 * blank" convention as the discount-reason fields elsewhere.
 */
export const updateKotSettingsSchema = z.object({
  kotHeaderText: z.string().trim().max(200).optional().or(z.literal("")),
});
