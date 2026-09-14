import "server-only";
import { and, desc, eq, lte } from "drizzle-orm";
import type { Transaction } from "@/db";
import { menuItemTaxRateHistory, menuItems } from "@/db/schema";

/**
 * Phase 6, Slice 6b — effective-dated tax rate configuration, LAYERED ON
 * TOP of the existing live `menuItems.taxRateBasisPoints` field (per
 * sign-off), never replacing it. `menu_item_tax_rate_history` (see its own
 * comment in schema.ts) is the single source of truth for "what rate
 * applied when"; `menuItems.taxRateBasisPoints` stays a fast, POS-readable
 * CACHE that this function keeps in sync — the POS's own pricing lookups
 * (orders.ts/combos.ts) are untouched and keep reading that live column
 * directly, so there is no change to the hot path.
 *
 * Every tax-rate change — at menu-item creation and every edit afterward —
 * must go through this one function so the live field is NEVER written
 * directly by a route. That is what makes the history table an actually
 * trustworthy audit trail rather than an optional log a caller could
 * bypass.
 *
 * Deliberately does NOT support scheduling a future rate to auto-apply on
 * its effective date: this codebase's own established convention (see
 * fixed-assets.ts's run-depreciation route comment) is that a periodic
 * change is a deliberately human-triggered action, never a background
 * cron — and there is no reconcile-on-read path here that would flip the
 * live cache on the day a future-dated row becomes due (adding one would
 * mean touching the POS's own fast pricing path on every order, the exact
 * risk "layer on top" was chosen to avoid). So `effectiveFrom` must be
 * today or a past date: this records a change that takes effect right
 * now, or corrects the record for a change that demonstrably already
 * happened (a backdated correction) — never a change staged for later.
 * The caller (the menu-item route) is responsible for validating
 * `effectiveFrom` against the restaurant's own "today" (via
 * `restaurantDate`) before calling this function.
 *
 * After inserting the new row, the live cache is resynced to whichever
 * row is now the most recent one with `effectiveFrom <= today` — NOT
 * necessarily the row just inserted. This matters for a backdated
 * correction: if rates of 13% (Jan 1) and 15% (Mar 1) already exist and
 * someone now backdates a correction to 14% effective Feb 1, the item's
 * live rate must stay 15% (Mar 1 is still the most recent date that has
 * passed) — the newly-inserted Feb 1 row corrects history without
 * pretending to be the current rate.
 */
export async function recordTaxRateChange(
  tx: Transaction,
  params: {
    restaurantId: string;
    menuItemId: string;
    taxRateBasisPoints: number;
    effectiveFrom: string; // YYYY-MM-DD, already validated by the caller as <= asOfDate
    // The restaurant's own "today" (via restaurantDate) — NOT necessarily
    // equal to `effectiveFrom`. Resolving the live cache against
    // `effectiveFrom` instead of the actual current date was an earlier
    // bug here: a backdated correction's own date would then wrongly act
    // as the upper bound, hiding a later row that is genuinely still the
    // current rate. See this function's own top-of-file comment for the
    // worked example this must get right.
    asOfDate: string;
    createdByUserId: string;
  },
): Promise<void> {
  await tx.insert(menuItemTaxRateHistory).values({
    restaurantId: params.restaurantId,
    menuItemId: params.menuItemId,
    taxRateBasisPoints: params.taxRateBasisPoints,
    effectiveFrom: params.effectiveFrom,
    createdByUserId: params.createdByUserId,
  });

  const [current] = await tx
    .select({ taxRateBasisPoints: menuItemTaxRateHistory.taxRateBasisPoints })
    .from(menuItemTaxRateHistory)
    .where(
      and(
        eq(menuItemTaxRateHistory.menuItemId, params.menuItemId),
        lte(menuItemTaxRateHistory.effectiveFrom, params.asOfDate),
      ),
    )
    .orderBy(desc(menuItemTaxRateHistory.effectiveFrom))
    .limit(1);

  // `current` cannot be missing — the row just inserted above always
  // qualifies (effectiveFrom <= asOfDate, per the caller's own contract)
  // — but guard defensively rather than asserting, since a live cache
  // write is exactly the kind of place a silent no-op is worse than a
  // visible skip.
  if (current) {
    await tx
      .update(menuItems)
      .set({ taxRateBasisPoints: current.taxRateBasisPoints, updatedAt: new Date() })
      .where(eq(menuItems.id, params.menuItemId));
  }
}

export type TaxRateHistoryEntry = {
  id: string;
  taxRateBasisPoints: number;
  effectiveFrom: string;
  createdAt: Date;
  createdByUserId: string;
};

/** Full history for one menu item, most recent effective date first — the shape the menu-item detail UI reads to show "what changed, when." */
export async function getTaxRateHistory(
  tx: Transaction,
  params: { menuItemId: string },
): Promise<TaxRateHistoryEntry[]> {
  return tx
    .select({
      id: menuItemTaxRateHistory.id,
      taxRateBasisPoints: menuItemTaxRateHistory.taxRateBasisPoints,
      effectiveFrom: menuItemTaxRateHistory.effectiveFrom,
      createdAt: menuItemTaxRateHistory.createdAt,
      createdByUserId: menuItemTaxRateHistory.createdByUserId,
    })
    .from(menuItemTaxRateHistory)
    .where(eq(menuItemTaxRateHistory.menuItemId, params.menuItemId))
    .orderBy(desc(menuItemTaxRateHistory.effectiveFrom));
}
