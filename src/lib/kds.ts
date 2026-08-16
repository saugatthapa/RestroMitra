/**
 * Kitchen Display System (KDS) rules — Phase 6. Deliberately a plain,
 * dependency-free module (no "server-only", no DB import), same pattern as
 * order-status.ts and payments.ts, so it's shared unmodified between the
 * status API route and the dashboard KDS board and is trivially
 * unit-tested.
 *
 * Design choice: the KDS does NOT introduce a second, per-item status
 * separate from the order-level status state machine in order-status.ts.
 * An order still has exactly one status. What KDS adds is (a) a narrower
 * set of transitions kitchen staff specifically are allowed to make, and
 * (b) a way to group one order's items into per-station tickets for
 * display. See PHASE_6_NOTES.md for the tradeoff this implies for orders
 * that span multiple stations (one station "finishing" advances the whole
 * order, even if another station's items on the same order aren't ready
 * yet) — a deliberate v1 simplification, not an oversight.
 */

import type { OrderStatus } from "./order-status";

/**
 * Statuses a kitchen ticket board should show at all. A "pending" order
 * hasn't been accepted by front-of-house yet (that's a waiter/POS/QR-flow
 * concern, not kitchen's), and "served"/"completed"/"cancelled" orders have
 * nothing left for the kitchen to do.
 */
export const KDS_VISIBLE_STATUSES: OrderStatus[] = ["confirmed", "preparing", "ready"];

/**
 * The only two transitions a kitchen ticket board itself drives:
 * "start cooking" and "done cooking, ready for pickup/service". Accepting a
 * new order (pending -> confirmed) is a front-of-house decision, and moving
 * a ready order on to served/completed is a service/billing concern — both
 * stay gated behind EDIT_ORDER, not UPDATE_KDS_STATUS, even though a
 * manager/owner holding EDIT_ORDER can still do everything from either
 * screen.
 */
const KITCHEN_TRANSITIONS: Array<[OrderStatus, OrderStatus]> = [
  ["confirmed", "preparing"],
  ["preparing", "ready"],
];

export function isKitchenTransition(from: OrderStatus, to: OrderStatus): boolean {
  return KITCHEN_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

export const UNASSIGNED_STATION_ID = "unassigned";
export const UNASSIGNED_STATION_NAME = "Unassigned";

export type StationTicketItem = {
  kitchenStationId: string | null;
  kitchenStationNameSnapshot: string | null;
};

export type StationRef = { id: string; name: string };

/** Resolves the display station for one order item — items with no station assigned on the menu still need somewhere to show up. */
export function stationForItem(item: StationTicketItem): StationRef {
  if (item.kitchenStationId && item.kitchenStationNameSnapshot) {
    return { id: item.kitchenStationId, name: item.kitchenStationNameSnapshot };
  }
  return { id: UNASSIGNED_STATION_ID, name: UNASSIGNED_STATION_NAME };
}

/**
 * Groups the distinct stations represented across a set of order items,
 * sorted by name (with "Unassigned" always last regardless of how it
 * alphabetizes — it's a catch-all, not a real station). Used to build the
 * KDS board's station tabs from whatever's actually in today's orders,
 * rather than requiring every restaurant to pre-configure stations before
 * KDS is useful at all.
 */
export function distinctStations(items: StationTicketItem[]): StationRef[] {
  const byId = new Map<string, StationRef>();
  for (const item of items) {
    const station = stationForItem(item);
    if (!byId.has(station.id)) byId.set(station.id, station);
  }
  return [...byId.values()].sort((a, b) => {
    if (a.id === UNASSIGNED_STATION_ID) return 1;
    if (b.id === UNASSIGNED_STATION_ID) return -1;
    return a.name.localeCompare(b.name);
  });
}

/** Filters one order's items down to just the ones belonging to a given station (pass UNASSIGNED_STATION_ID to get the catch-all group). */
export function itemsForStation<T extends StationTicketItem>(
  items: T[],
  stationId: string,
): T[] {
  return items.filter((item) => stationForItem(item).id === stationId);
}
