/**
 * Kitchen Order Ticket formatting — Phase 17. Deliberately a plain,
 * dependency-free module (no "server-only", no DB import), same pattern as
 * order-status.ts/kds.ts, so it's shared unmodified between the ticket
 * print page and is trivially unit-testable. Reuses kds.ts's station
 * grouping (distinctStations/itemsForStation) rather than re-deriving it —
 * "which station does this item belong to" must stay one answer across the
 * KDS board and the printed ticket.
 */
import { distinctStations, itemsForStation, type StationRef, type StationTicketItem } from "@/lib/kds";

export type KotTicketItem = StationTicketItem & {
  id: string;
  menuItemNameSnapshot: string;
  variantNameSnapshot: string | null;
  quantity: number;
  notes: string | null;
  addons: { id: string; nameSnapshot: string }[];
};

export type KotStationTicket = {
  station: StationRef;
  items: KotTicketItem[];
};

/**
 * One physical ticket per station represented on the order — a kitchen
 * with a Momo station and a Bar shouldn't have to page through drink
 * orders to find their momo items, and vice versa. An order with only one
 * station in play still produces exactly one ticket (the array is never
 * padded to a fixed station count).
 */
export function buildKotStationTickets(items: KotTicketItem[]): KotStationTicket[] {
  return distinctStations(items).map((station) => ({
    station,
    items: itemsForStation(items, station.id),
  }));
}

/** Falls back to the restaurant's legal name when no custom KOT header text is configured (or it's blank/whitespace-only). */
export function resolveKotHeaderText(restaurant: {
  name: string;
  kotHeaderText: string | null;
}): string {
  return restaurant.kotHeaderText?.trim() || restaurant.name;
}
