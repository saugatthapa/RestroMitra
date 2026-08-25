import "server-only";
import { randomBytes } from "crypto";
import { db } from "@/db";
import { applyTax } from "@/lib/money";
import { HttpError } from "@/lib/http-error";
import { restaurantDate } from "@/lib/restaurant-date";

export class OrderValidationError extends HttpError {
  constructor(message: string) {
    super(message, 400);
  }
}

export type CartAddonInput = { addonId: string };
export type CartItemInput = {
  menuItemId: string;
  variantId?: string | null;
  quantity: number;
  addons?: CartAddonInput[];
  notes?: string;
};

export type ComputedOrderItemAddon = {
  addonId: string;
  nameSnapshot: string;
  priceInPaisaSnapshot: number;
};

export type ComputedOrderItem = {
  menuItemId: string;
  menuItemNameSnapshot: string;
  variantId: string | null;
  variantNameSnapshot: string | null;
  kitchenStationId: string | null;
  kitchenStationNameSnapshot: string | null;
  unitPriceInPaisa: number;
  quantity: number;
  lineSubtotalInPaisa: number;
  addonsTotalInPaisa: number;
  lineTotalInPaisa: number;
  notes: string | null;
  addons: ComputedOrderItemAddon[];
  // Commercial Launch Phase B.8 — Combos. Null for every item computed by
  // computeOrderPricing itself (a combo's exploded component rows are
  // produced by computeComboPricing in src/lib/combos.ts instead, sharing
  // this same type so both can be inserted through one identical code path
  // in the order-creation route — see that route's own comment).
  comboGroupId: string | null;
  comboNameSnapshot: string | null;
};

export type ComputedOrderPricing = {
  items: ComputedOrderItem[];
  subtotalInPaisa: number;
  taxInPaisa: number;
  totalInPaisa: number;
};

/**
 * Recomputes an entire cart's pricing from the current, authoritative menu
 * data in the database — every unit price, addon price, and tax rate here
 * comes from the menu row, NEVER from anything the client submitted. A
 * client can send whatever `price` fields it wants in the request body;
 * this function ignores all of them. This is the single choke point that
 * makes the public, unauthenticated /api/order/[token] endpoint safe to
 * expose: no matter what a malicious client sends, the amount actually
 * charged is only ever derived server-side from menu rows scoped to the
 * resolved restaurant.
 *
 * Throws OrderValidationError (mapped to a 400 by toErrorResponse) for any
 * item/variant/addon that doesn't exist, isn't active, or isn't currently
 * available/orderable — never silently drops or substitutes something.
 */
export async function computeOrderPricing(
  restaurantId: string,
  cartItems: CartItemInput[],
): Promise<ComputedOrderPricing> {
  if (cartItems.length === 0) {
    throw new OrderValidationError("Your cart is empty.");
  }

  const menuItemIds = [...new Set(cartItems.map((c) => c.menuItemId))];

  // Perf: this runs on every order submission (both the public QR route and
  // staff POS), so it's the single hottest read in the app — and the
  // default relational-query shape selects EVERY menuItems column,
  // including `imageUrl` (a base64 data: URL that can be a few hundred KB
  // PER item, see the schema/validation comments on it) and `description`,
  // neither of which pricing needs at all. Explicitly projecting down to
  // only the columns actually read below keeps this query's payload
  // proportional to cart size, not to how many of the restaurant's menu
  // photos happen to be attached to items in the cart.
  const rows = await db.query.menuItems.findMany({
    where: (mi, { and: and_, eq: eq_, inArray }) =>
      and_(eq_(mi.restaurantId, restaurantId), inArray(mi.id, menuItemIds)),
    columns: {
      id: true,
      name: true,
      basePriceInPaisa: true,
      taxRateBasisPoints: true,
      isActive: true,
      isAvailable: true,
      kitchenStationId: true,
    },
    with: { variants: true, addons: true, kitchenStation: true },
  });
  const itemsById = new Map(rows.map((r) => [r.id, r]));

  const computedItems: ComputedOrderItem[] = [];
  let subtotalInPaisa = 0;
  let taxInPaisa = 0;

  for (const cartLine of cartItems) {
    const item = itemsById.get(cartLine.menuItemId);
    if (!item || !item.isActive || !item.isAvailable) {
      throw new OrderValidationError(
        "One or more items in your order are no longer available. Please refresh the menu.",
      );
    }

    let unitPriceInPaisa: number;
    let variantNameSnapshot: string | null = null;
    let variantId: string | null = null;

    const activeVariants = item.variants.filter((v) => v.isActive);
    if (activeVariants.length > 0) {
      // This item requires a variant selection — its base price is not
      // orderable on its own (see schema.ts comment on menuItems).
      const variant = cartLine.variantId
        ? activeVariants.find((v) => v.id === cartLine.variantId)
        : undefined;
      if (!variant) {
        throw new OrderValidationError(
          `Please choose a size/option for "${item.name}".`,
        );
      }
      unitPriceInPaisa = variant.priceInPaisa;
      variantNameSnapshot = variant.name;
      variantId = variant.id;
    } else {
      if (cartLine.variantId) {
        // The item has no variants at all, yet the cart line names one —
        // most likely a stale client (menu changed since the page loaded)
        // or a tampered request. Reject rather than silently ignoring it
        // and charging the base price, which would hide the mismatch.
        throw new OrderValidationError(
          `"${item.name}" doesn't have that option. Please refresh the menu.`,
        );
      }
      unitPriceInPaisa = item.basePriceInPaisa;
    }

    const quantity = cartLine.quantity;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) {
      throw new OrderValidationError(
        `Quantity for "${item.name}" must be between 1 and 50.`,
      );
    }

    const availableAddons = item.addons.filter((a) => a.isAvailable);
    const chosenAddonIds = [...new Set((cartLine.addons ?? []).map((a) => a.addonId))];
    const computedAddons: ComputedOrderItemAddon[] = chosenAddonIds.map((addonId) => {
      const addon = availableAddons.find((a) => a.id === addonId);
      if (!addon) {
        throw new OrderValidationError(
          `One of the add-ons chosen for "${item.name}" is no longer available.`,
        );
      }
      return {
        addonId: addon.id,
        nameSnapshot: addon.name,
        priceInPaisaSnapshot: addon.priceInPaisa,
      };
    });

    const addonUnitTotal = computedAddons.reduce((sum, a) => sum + a.priceInPaisaSnapshot, 0);
    const lineSubtotalInPaisa = unitPriceInPaisa * quantity;
    const addonsTotalInPaisa = addonUnitTotal * quantity;
    const lineTotalInPaisa = lineSubtotalInPaisa + addonsTotalInPaisa;
    const lineTaxInPaisa = applyTax(lineTotalInPaisa, item.taxRateBasisPoints);

    computedItems.push({
      menuItemId: item.id,
      menuItemNameSnapshot: item.name,
      variantId,
      variantNameSnapshot,
      kitchenStationId: item.kitchenStation?.id ?? null,
      kitchenStationNameSnapshot: item.kitchenStation?.name ?? null,
      unitPriceInPaisa,
      quantity,
      lineSubtotalInPaisa,
      addonsTotalInPaisa,
      lineTotalInPaisa,
      notes: cartLine.notes?.trim() || null,
      addons: computedAddons,
      comboGroupId: null,
      comboNameSnapshot: null,
    });

    subtotalInPaisa += lineTotalInPaisa;
    taxInPaisa += lineTaxInPaisa;
  }

  if (computedItems.length > 40) {
    throw new OrderValidationError("Too many distinct items in one order.");
  }

  return {
    items: computedItems,
    subtotalInPaisa,
    taxInPaisa,
    totalInPaisa: subtotalInPaisa + taxInPaisa,
  };
}

/**
 * Human-facing order number, unique per restaurant (enforced by a DB
 * unique index on (restaurant_id, order_number), not by this function
 * alone — see each caller's own retry-on-collision loop that actually
 * guarantees it). Format: YYYYMMDD-XXXX, e.g. "20260814-9K2F". Not a
 * sequential counter — a per-tenant atomic sequence is more machinery than
 * a single-branch QR-ordering phase needs; this is revisited if/when
 * Phase 4's POS wants strictly sequential daily numbers.
 *
 * The date part is purely a human-facing label baked into the receipt
 * number (uniqueness comes from the random suffix + DB constraint
 * regardless), but it should still say the right day: computed in the
 * RESTAURANT's own timezone so an order placed at 11:50pm Kathmandu time
 * doesn't get stamped with tomorrow's UTC date.
 */
export function generateOrderNumber(timezone: string): string {
  const datePart = restaurantDate(timezone).replace(/-/g, "");
  const randomPart = randomBytes(3).toString("hex").toUpperCase().slice(0, 4);
  return `${datePart}-${randomPart}`;
}
