import "server-only";
import { randomUUID } from "crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { menuCombos, menuComboItems, menuItems, menuVariants, kitchenStations } from "@/db/schema";
import { HttpError } from "@/lib/http-error";
import { applyTax } from "@/lib/money";
import type { ComputedOrderItem, ComputedOrderPricing } from "@/lib/orders";

export class ComboError extends HttpError {
  constructor(message: string, status = 400) {
    super(message, status);
  }
}

export type CartComboInput = {
  comboId: string;
  quantity: number;
};

/**
 * Verifies every item a combo builder submits actually belongs to this
 * restaurant, and that a named variant actually belongs to the named menu
 * item — same "resolve, don't trust" posture as every other cross-reference
 * in this codebase (see menu-items/route.ts's categoryOwned check). Called
 * by both the combo create and update routes before writing
 * menuComboItems rows. Throws ComboError (400/404) rather than letting a
 * bad reference either silently fail a later FK insert or, worse, silently
 * attach the wrong variant.
 */
export async function assertComboItemsOwnership(
  restaurantId: string,
  items: { menuItemId: string; variantId?: string | null }[],
): Promise<void> {
  const menuItemIds = [...new Set(items.map((i) => i.menuItemId))];
  const ownedItems = await db
    .select({ id: menuItems.id })
    .from(menuItems)
    .where(and(eq(menuItems.restaurantId, restaurantId), inArray(menuItems.id, menuItemIds)));
  const ownedItemIds = new Set(ownedItems.map((r) => r.id));
  for (const item of items) {
    if (!ownedItemIds.has(item.menuItemId)) {
      throw new ComboError("One of the selected menu items wasn't found.", 404);
    }
  }

  const variantIds = [...new Set(items.map((i) => i.variantId).filter((v): v is string => Boolean(v)))];
  if (variantIds.length === 0) return;
  const ownedVariants = await db
    .select({ id: menuVariants.id, menuItemId: menuVariants.menuItemId })
    .from(menuVariants)
    .where(inArray(menuVariants.id, variantIds));
  const variantOwnerByMenuItem = new Map(ownedVariants.map((v) => [v.id, v.menuItemId]));
  for (const item of items) {
    if (!item.variantId) continue;
    if (variantOwnerByMenuItem.get(item.variantId) !== item.menuItemId) {
      throw new ComboError("One of the selected menu options doesn't belong to its item.", 404);
    }
  }
}

/** Same shape as ComputedOrderPricing (orders.ts) — kept as a distinct name since it only ever covers combo lines, merged with regular-item pricing by the caller. */
export type ComboPricing = Pick<ComputedOrderPricing, "items" | "subtotalInPaisa" | "taxInPaisa">;

/**
 * Explodes every combo cart line into ordinary ComputedOrderItem rows,
 * allocating each combo's fixed priceInPaisa proportionally across its
 * constituent items (by their own normal unit price × per-bundle quantity),
 * so downstream code never needs to know a combo was involved — see
 * menuCombos' own doc comment in schema.ts for the full rationale.
 *
 * Allocation is computed PER BUNDLE (remainder-to-last-component, so the
 * per-bundle allocations always sum to EXACTLY combo.priceInPaisa), then
 * multiplied by the cart line's requested bundle quantity — this keeps
 * `subtotalInPaisa` for N bundles always exactly `combo.priceInPaisa * N`,
 * never off by a paisa from rounding.
 *
 * Mirrors computeOrderPricing's own validation posture (never trust
 * anything but current DB state, reject rather than substitute) but never
 * mutates anything — pure computation, same as its sibling.
 */
export async function computeComboPricing(
  restaurantId: string,
  comboLines: CartComboInput[],
): Promise<ComboPricing> {
  if (comboLines.length === 0) {
    return { items: [], subtotalInPaisa: 0, taxInPaisa: 0 };
  }

  const comboIds = [...new Set(comboLines.map((c) => c.comboId))];

  const combos = await db
    .select()
    .from(menuCombos)
    .where(and(eq(menuCombos.restaurantId, restaurantId), inArray(menuCombos.id, comboIds)));
  const combosById = new Map(combos.map((c) => [c.id, c]));

  const componentRows = await db
    .select({
      comboId: menuComboItems.comboId,
      menuItemId: menuComboItems.menuItemId,
      variantId: menuComboItems.variantId,
      quantity: menuComboItems.quantity,
      itemName: menuItems.name,
      basePriceInPaisa: menuItems.basePriceInPaisa,
      taxRateBasisPoints: menuItems.taxRateBasisPoints,
      isActive: menuItems.isActive,
      isAvailable: menuItems.isAvailable,
      kitchenStationId: menuItems.kitchenStationId,
      kitchenStationNameSnapshot: kitchenStations.name,
      variantName: menuVariants.name,
      variantPriceInPaisa: menuVariants.priceInPaisa,
      variantIsActive: menuVariants.isActive,
    })
    .from(menuComboItems)
    .innerJoin(menuItems, eq(menuItems.id, menuComboItems.menuItemId))
    .leftJoin(menuVariants, eq(menuVariants.id, menuComboItems.variantId))
    .leftJoin(kitchenStations, eq(kitchenStations.id, menuItems.kitchenStationId))
    .where(inArray(menuComboItems.comboId, comboIds));

  const componentsByCombo = new Map<string, typeof componentRows>();
  for (const row of componentRows) {
    const list = componentsByCombo.get(row.comboId) ?? [];
    list.push(row);
    componentsByCombo.set(row.comboId, list);
  }

  const items: ComputedOrderItem[] = [];
  let subtotalInPaisa = 0;
  let taxInPaisa = 0;

  for (const line of comboLines) {
    const quantity = line.quantity;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) {
      throw new ComboError("Combo quantity must be between 1 and 50.");
    }

    const combo = combosById.get(line.comboId);
    if (!combo || !combo.isActive) {
      throw new ComboError("One or more combos in your order are no longer available.", 404);
    }

    const components = componentsByCombo.get(combo.id) ?? [];
    if (components.length === 0) {
      throw new ComboError(`"${combo.name}" has no items configured and can't be ordered.`);
    }
    for (const c of components) {
      if (!c.isActive || !c.isAvailable) {
        throw new ComboError(
          `"${combo.name}" includes an item that's no longer available. Please check the combo's setup.`,
        );
      }
      if (c.variantId && !c.variantIsActive) {
        throw new ComboError(
          `"${combo.name}" includes a menu option that's no longer available. Please check the combo's setup.`,
        );
      }
    }

    // Weight = each component's own normal unit price × how many of it one
    // bundle includes — a component priced higher (or included in greater
    // quantity) absorbs proportionally more of the bundle's fixed price.
    const weights = components.map((c) => (c.variantPriceInPaisa ?? c.basePriceInPaisa) * c.quantity);
    const sumWeights = weights.reduce((s, w) => s + w, 0);
    if (sumWeights <= 0) {
      // Unreachable under normal data (menu item/variant prices are always
      // positive) — defensive guard against a corrupt combo config rather
      // than dividing by zero below.
      throw new ComboError(`"${combo.name}" can't be priced — check its item configuration.`, 500);
    }

    const perBundleAllocations = weights.map((w) => Math.floor((combo.priceInPaisa * w) / sumWeights));
    const allocatedSoFar = perBundleAllocations.reduce((s, a) => s + a, 0);
    // Remainder-to-last, same convention as Split Bill's planned share
    // rounding and every other proportional-allocation spot in this
    // codebase — keeps the sum exact without a fairness dispute over which
    // component "deserves" the extra paisa.
    perBundleAllocations[perBundleAllocations.length - 1] += combo.priceInPaisa - allocatedSoFar;

    const comboGroupId = randomUUID();

    components.forEach((c, index) => {
      const rowQuantity = c.quantity * quantity;
      const lineTotalInPaisa = perBundleAllocations[index] * quantity;
      const unitPriceInPaisa = rowQuantity > 0 ? Math.round(lineTotalInPaisa / rowQuantity) : 0;
      const lineTaxInPaisa = applyTax(lineTotalInPaisa, c.taxRateBasisPoints);

      items.push({
        menuItemId: c.menuItemId,
        menuItemNameSnapshot: c.itemName,
        variantId: c.variantId,
        variantNameSnapshot: c.variantName,
        kitchenStationId: c.kitchenStationId,
        kitchenStationNameSnapshot: c.kitchenStationNameSnapshot,
        unitPriceInPaisa,
        quantity: rowQuantity,
        lineSubtotalInPaisa: lineTotalInPaisa,
        addonsTotalInPaisa: 0,
        lineTotalInPaisa,
        notes: null,
        addons: [],
        comboGroupId,
        comboNameSnapshot: combo.name,
      });

      subtotalInPaisa += lineTotalInPaisa;
      taxInPaisa += lineTaxInPaisa;
    });
  }

  return { items, subtotalInPaisa, taxInPaisa };
}
