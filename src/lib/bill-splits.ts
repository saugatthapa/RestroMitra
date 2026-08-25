import "server-only";
import { and, asc, eq } from "drizzle-orm";
import type { Database, Transaction } from "@/db";
import { orders, orderItems, orderBillSplits, orderBillSplitItems, payments } from "@/db/schema";
import { HttpError } from "@/lib/http-error";

/**
 * Commercial Launch Phase B.9 — Split Bill (item-level). The pure
 * money-math half of this module (computeItemNetUnitAmounts,
 * computeBillSplitSummary) takes only plain data — no DB, no request
 * context — same "pure derivation" shape as src/lib/payments.ts, just
 * co-located here with replaceBillSplits (the transactional write half)
 * rather than split across two files, matching how src/lib/tables.ts and
 * src/lib/combos.ts each mix pure helpers with DB-touching functions in
 * one server-only module for one feature.
 *
 * Nothing here is ever stored: a share's amounts are always DERIVED from
 * the order's current items + adjustments, the same "never store what you
 * can recompute correctly" posture as computeBillingSummary itself. See
 * orderBillSplits' own doc comment in schema.ts for the full design.
 *
 * ---------------------------------------------------------------------
 * How the math works
 * ---------------------------------------------------------------------
 * 1. Each order item's own LINE TOTAL (lineTotalInPaisa, which already
 *    includes its addons) is its weight. Because
 *    order.subtotalInPaisa === sum(item.lineTotalInPaisa) exactly (see
 *    computeOrderPricing in orders.ts), the order-level discount, service
 *    charge, and tax can each be allocated across items proportionally by
 *    that weight, remainder-to-the-last-item, so the per-item shares
 *    always sum to EXACTLY the order-level amount — no rounding drift.
 *
 *    Tax is allocated the same proportional way rather than recomputed
 *    per item's own tax rate — order items don't retain a per-line tax
 *    snapshot (only the order-level total is stored), so this is a
 *    deliberate, documented approximation, not a precision bug. It only
 *    matters when items on the same order carry meaningfully different
 *    tax rates, which most restaurants don't do.
 *
 * 2. Each item's own NET total (its line total, minus its discount share,
 *    plus its service-charge and tax shares) is then split evenly across
 *    its `quantity` UNITS (again remainder-to-the-first-units), so a
 *    partial-quantity assignment (e.g. "2 of these 3 momos") gets an
 *    exact, fair per-unit price.
 *
 * 3. A split's total is the sum of whatever units it's been assigned;
 *    anything left over is the "unassigned" bucket. Because every step
 *    above is an exact partition (no item, no unit, no paisa is ever
 *    double-counted or dropped), splits.total + unassigned.total is
 *    always EXACTLY order.totalInPaisa.
 */

export type SplitOrderItem = {
  id: string;
  quantity: number;
  lineTotalInPaisa: number;
};

export type OrderForSplit = {
  subtotalInPaisa: number;
  discountInPaisa: number;
  serviceChargeInPaisa: number;
  taxInPaisa: number;
  totalInPaisa: number;
};

export type SplitDefinition = { id: string; label: string };

/** One (split, orderItem) assignment — how many units of that item this
 * split claims. Callers must pass these in the order they were created
 * (ascending createdAt) — see the module doc comment's step 3: units are
 * claimed first-come-first-served across assignments for the same item,
 * so a consistent order keeps which literal unit a share "owns" stable
 * across recomputes even though the money itself doesn't depend on it. */
export type SplitItemAssignment = { splitId: string; orderItemId: string; quantity: number };

export type PaymentForSplit = { splitId: string | null; amountInPaisa: number };

export type SplitShareSummary = {
  splitId: string;
  label: string;
  itemCount: number;
  subtotalInPaisa: number;
  paidInPaisa: number;
  remainingDueInPaisa: number;
};

export type UnassignedSummary = { itemCount: number; subtotalInPaisa: number };

export type BillSplitSummary = {
  splits: SplitShareSummary[];
  unassigned: UnassignedSummary;
  /** Always splits.reduce(+ subtotalInPaisa) + unassigned.subtotalInPaisa — exposed as a
   * cross-check the caller/tests can assert against order.totalInPaisa. */
  totalInPaisa: number;
};

/** Splits `total` across `weights` proportionally, remainder to the last
 * entry, so the result always sums to EXACTLY `total`. Shared by both the
 * order-level-adjustment allocation (step 1) and the per-unit allocation
 * (step 2) above — same convention as computeComboPricing's per-bundle
 * allocation in combos.ts. */
function allocateProportional(total: number, weights: number[]): number[] {
  const sumWeights = weights.reduce((s, w) => s + w, 0);
  if (weights.length === 0) return [];
  if (sumWeights <= 0) {
    // No positive weight to allocate against (defensive only — every real
    // order item has a positive lineTotalInPaisa) — put it all on the
    // first entry rather than dividing by zero.
    return weights.map((_, i) => (i === 0 ? total : 0));
  }
  const per = weights.map((w) => Math.floor((total * w) / sumWeights));
  const allocated = per.reduce((s, a) => s + a, 0);
  per[per.length - 1] += total - allocated;
  return per;
}

/** Splits `total` into `count` per-unit amounts, remainder to the first
 * units, summing to exactly `total`. */
function splitEvenly(total: number, count: number): number[] {
  if (count <= 0) return [];
  const base = Math.floor(total / count);
  const remainder = total - base * count;
  return Array.from({ length: count }, (_, i) => base + (i < remainder ? 1 : 0));
}

/**
 * Step 1+2 above: for every order item, its per-UNIT net amounts (length
 * === item.quantity, summing to exactly that item's own net share of the
 * order total).
 */
export function computeItemNetUnitAmounts(
  order: OrderForSplit,
  items: SplitOrderItem[],
): Map<string, number[]> {
  const sorted = [...items].sort((a, b) => a.id.localeCompare(b.id));
  const weights = sorted.map((i) => i.lineTotalInPaisa);

  const discountShares = allocateProportional(order.discountInPaisa, weights);
  const serviceChargeShares = allocateProportional(order.serviceChargeInPaisa, weights);
  const taxShares = allocateProportional(order.taxInPaisa, weights);

  const result = new Map<string, number[]>();
  sorted.forEach((item, index) => {
    const netTotal =
      item.lineTotalInPaisa - discountShares[index] + serviceChargeShares[index] + taxShares[index];
    result.set(item.id, splitEvenly(netTotal, item.quantity));
  });
  return result;
}

/**
 * Step 3 above: resolves every split's claimed units against each item's
 * per-unit amounts and sums them, with whatever's left over reported as
 * `unassigned`. Pure function of its inputs — safe to call on every read
 * (order GET, splits GET) with no caching/staleness concern.
 */
export function computeBillSplitSummary(params: {
  order: OrderForSplit;
  items: SplitOrderItem[];
  splits: SplitDefinition[];
  assignments: SplitItemAssignment[];
  payments: PaymentForSplit[];
}): BillSplitSummary {
  const { order, items, splits, assignments, payments } = params;
  const perUnitByItem = computeItemNetUnitAmounts(order, items);
  const quantityByItem = new Map(items.map((i) => [i.id, i.quantity]));
  const claimedCountByItem = new Map<string, number>();

  const totalsBySplit = new Map<string, { itemCount: number; subtotalInPaisa: number }>();
  for (const split of splits) {
    totalsBySplit.set(split.id, { itemCount: 0, subtotalInPaisa: 0 });
  }

  for (const assignment of assignments) {
    const units = perUnitByItem.get(assignment.orderItemId) ?? [];
    const alreadyClaimed = claimedCountByItem.get(assignment.orderItemId) ?? 0;
    // Defensive clamp — never claim past the item's own unit count, even
    // if a stale/inconsistent assignment set were ever passed in (the
    // write-side route is what actually enforces this invariant).
    const end = Math.min(units.length, alreadyClaimed + Math.max(0, assignment.quantity));
    const claimedUnits = units.slice(alreadyClaimed, end);
    claimedCountByItem.set(assignment.orderItemId, end);

    const bucket = totalsBySplit.get(assignment.splitId);
    if (!bucket) continue; // assignment references a split not in `splits` — ignore rather than throw on read
    bucket.itemCount += claimedUnits.length;
    bucket.subtotalInPaisa += claimedUnits.reduce((s, a) => s + a, 0);
  }

  let unassignedItemCount = 0;
  let unassignedSubtotalInPaisa = 0;
  for (const item of items) {
    const units = perUnitByItem.get(item.id) ?? [];
    const claimed = claimedCountByItem.get(item.id) ?? 0;
    const leftover = units.slice(claimed, quantityByItem.get(item.id) ?? units.length);
    unassignedItemCount += leftover.length;
    unassignedSubtotalInPaisa += leftover.reduce((s, a) => s + a, 0);
  }

  const paidBySplit = new Map<string, number>();
  for (const payment of payments) {
    if (!payment.splitId) continue;
    paidBySplit.set(payment.splitId, (paidBySplit.get(payment.splitId) ?? 0) + payment.amountInPaisa);
  }

  const shareSummaries: SplitShareSummary[] = splits.map((split) => {
    const totals = totalsBySplit.get(split.id) ?? { itemCount: 0, subtotalInPaisa: 0 };
    const paidInPaisa = paidBySplit.get(split.id) ?? 0;
    return {
      splitId: split.id,
      label: split.label,
      itemCount: totals.itemCount,
      subtotalInPaisa: totals.subtotalInPaisa,
      paidInPaisa,
      remainingDueInPaisa: Math.max(0, totals.subtotalInPaisa - paidInPaisa),
    };
  });

  return {
    splits: shareSummaries,
    unassigned: { itemCount: unassignedItemCount, subtotalInPaisa: unassignedSubtotalInPaisa },
    totalInPaisa:
      shareSummaries.reduce((s, share) => s + share.subtotalInPaisa, 0) + unassignedSubtotalInPaisa,
  };
}

export class BillSplitError extends HttpError {
  constructor(message: string, status = 400) {
    super(message, status);
  }
}

/**
 * Confirms a splitId a payment wants to tag itself with actually belongs
 * to THIS order — a bare FK check alone would only confirm the id exists
 * SOMEWHERE, not that it's one of this order's own shares (same
 * "resolve, don't trust" posture as assertComboItemsOwnership in
 * combos.ts). Called by the payments route before inserting a payment
 * with a splitId; throws BillSplitError(400) rather than letting a
 * cross-order id silently tag a payment to the wrong order's share.
 */
export async function assertSplitBelongsToOrder(
  tx: Database | Transaction,
  params: { orderId: string; splitId: string },
): Promise<void> {
  const [split] = await tx
    .select({ id: orderBillSplits.id })
    .from(orderBillSplits)
    .where(and(eq(orderBillSplits.id, params.splitId), eq(orderBillSplits.orderId, params.orderId)))
    .limit(1);
  if (!split) {
    throw new BillSplitError("That bill split doesn't exist on this order.");
  }
}

export type ReplaceBillSplitsParams = {
  restaurantId: string;
  orderId: string;
  splits: { label: string; items: { orderItemId: string; quantity: number }[] }[];
};

export type ReplaceBillSplitsResult = {
  splits: (typeof orderBillSplits.$inferSelect)[];
  splitItems: (typeof orderBillSplitItems.$inferSelect)[];
  items: { id: string; quantity: number; lineTotalInPaisa: number }[];
};

/**
 * Whole-state-replaces an order's entire set of bill splits inside the
 * caller's transaction — mirrors transferOrderToTable/holdOrder in
 * tables.ts: this function takes the row lock itself (so it's race-safe
 * called from anywhere, not just the one route that happens to call it
 * today) and throws BillSplitError on any rejection, leaving the caller's
 * `db.transaction(...)` to roll back the entire attempt (no partial
 * delete-without-reinsert can ever be observed).
 *
 * Validates that every referenced order item actually belongs to this
 * order, and that no item is claimed by more units than it actually has
 * — across the WHOLE requested set of splits, not just within one split
 * (see replaceBillSplitsSchema's own comment for why the request shape is
 * "the complete new set", not a patch).
 */
export async function replaceBillSplits(
  tx: Transaction,
  params: ReplaceBillSplitsParams,
): Promise<ReplaceBillSplitsResult> {
  const orderRows = await tx
    .select({ id: orders.id, status: orders.status })
    .from(orders)
    .where(and(eq(orders.id, params.orderId), eq(orders.restaurantId, params.restaurantId)))
    .for("update")
    .limit(1);
  const order = orderRows[0];
  if (!order) {
    throw new BillSplitError("Order not found.", 404);
  }
  if (order.status === "cancelled") {
    throw new BillSplitError("Cannot split a cancelled order's bill.");
  }

  const existingItems = await tx
    .select({ id: orderItems.id, quantity: orderItems.quantity, lineTotalInPaisa: orderItems.lineTotalInPaisa })
    .from(orderItems)
    .where(eq(orderItems.orderId, params.orderId));
  const quantityByItemId = new Map(existingItems.map((i) => [i.id, i.quantity]));

  const claimedByItemId = new Map<string, number>();
  for (const split of params.splits) {
    for (const item of split.items) {
      const quantity = quantityByItemId.get(item.orderItemId);
      if (quantity === undefined) {
        throw new BillSplitError("One of the selected items isn't on this order.", 404);
      }
      const claimed = (claimedByItemId.get(item.orderItemId) ?? 0) + item.quantity;
      claimedByItemId.set(item.orderItemId, claimed);
      if (claimed > quantity) {
        throw new BillSplitError(
          "An item is assigned to more shares than were ordered — check the quantities.",
        );
      }
    }
  }

  await tx.delete(orderBillSplits).where(eq(orderBillSplits.orderId, params.orderId));

  const insertedSplits =
    params.splits.length > 0
      ? await tx
          .insert(orderBillSplits)
          .values(params.splits.map((s) => ({ restaurantId: params.restaurantId, orderId: params.orderId, label: s.label })))
          .returning()
      : [];

  const splitItemValues = insertedSplits.flatMap((split, index) =>
    params.splits[index].items.map((item) => ({
      splitId: split.id,
      orderItemId: item.orderItemId,
      quantity: item.quantity,
    })),
  );
  const insertedItems =
    splitItemValues.length > 0 ? await tx.insert(orderBillSplitItems).values(splitItemValues).returning() : [];

  return { splits: insertedSplits, splitItems: insertedItems, items: existingItems };
}

/** Fetches an order's current splits + assignments + the money summary —
 * shared by the GET route and by replaceBillSplits' own caller (the PUT
 * route re-reads post-write rather than trusting its own inputs, same
 * "never trust the request body for the response" posture as every other
 * write route in this codebase). Takes a plain db/tx handle since reads
 * don't need a lock. */
export async function loadBillSplitSummary(
  tx: Database | Transaction,
  params: { restaurantId: string; orderId: string },
): Promise<{
  splits: { id: string; label: string; items: { orderItemId: string; quantity: number }[] }[];
  summary: BillSplitSummary;
}> {
  const orderRows = await tx
    .select({
      subtotalInPaisa: orders.subtotalInPaisa,
      discountInPaisa: orders.discountInPaisa,
      serviceChargeInPaisa: orders.serviceChargeInPaisa,
      taxInPaisa: orders.taxInPaisa,
      totalInPaisa: orders.totalInPaisa,
    })
    .from(orders)
    .where(and(eq(orders.id, params.orderId), eq(orders.restaurantId, params.restaurantId)))
    .limit(1);
  const order = orderRows[0];
  if (!order) {
    throw new BillSplitError("Order not found.", 404);
  }

  const items = await tx
    .select({ id: orderItems.id, quantity: orderItems.quantity, lineTotalInPaisa: orderItems.lineTotalInPaisa })
    .from(orderItems)
    .where(eq(orderItems.orderId, params.orderId));

  const splits = await tx
    .select({ id: orderBillSplits.id, label: orderBillSplits.label })
    .from(orderBillSplits)
    .where(eq(orderBillSplits.orderId, params.orderId))
    .orderBy(asc(orderBillSplits.createdAt));

  const splitItems = await tx
    .select({
      id: orderBillSplitItems.id,
      splitId: orderBillSplitItems.splitId,
      orderItemId: orderBillSplitItems.orderItemId,
      quantity: orderBillSplitItems.quantity,
    })
    .from(orderBillSplitItems)
    .innerJoin(orderBillSplits, eq(orderBillSplits.id, orderBillSplitItems.splitId))
    .where(eq(orderBillSplits.orderId, params.orderId))
    .orderBy(asc(orderBillSplitItems.createdAt));

  const paymentRows = await tx
    .select({ splitId: payments.splitId, amountInPaisa: payments.amountInPaisa })
    .from(payments)
    .where(eq(payments.orderId, params.orderId));

  const splitsWithItems = splits.map((split) => ({
    ...split,
    items: splitItems
      .filter((si) => si.splitId === split.id)
      .map((si) => ({ orderItemId: si.orderItemId, quantity: si.quantity })),
  }));

  const summary = computeBillSplitSummary({
    order,
    items,
    splits,
    assignments: splitItems,
    payments: paymentRows,
  });

  return { splits: splitsWithItems, summary };
}
