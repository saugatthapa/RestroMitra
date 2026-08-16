/**
 * The table lifecycle — Phase 12. Deliberately a plain, dependency-free
 * module (no "server-only", no DB import), same pattern as order-status.ts
 * and reservation-status.ts, so it's shared unmodified between API routes
 * and the floor-plan UI.
 *
 * Unlike orders/reservations, a table's status is mostly NOT driven by a
 * direct staff action — it's derived automatically from order/reservation
 * activity on that table (see src/lib/tables.ts's deriveTableStatus(),
 * which queries the DB and calls into the pure helpers here). Only two
 * transitions are staff-driven directly: finishing cleaning
 * (cleaning -> available), and marking a table broken/unusable
 * (any -> out_of_service, and back). Everything else — ordering, occupied,
 * reserved, payment_pending, cleaning (arrived at from completed) — is
 * system-driven so the floor plan reflects reality without staff having to
 * remember to update it by hand.
 */

export const TABLE_STATUSES = [
  "available",
  "ordering",
  "occupied",
  "reserved",
  "payment_pending",
  "cleaning",
  "out_of_service",
] as const;

export type TableStatus = (typeof TABLE_STATUSES)[number];

export const TABLE_STATUS_LABELS: Record<TableStatus, string> = {
  available: "Available",
  ordering: "Ordering",
  occupied: "Occupied",
  reserved: "Reserved",
  payment_pending: "Payment pending",
  cleaning: "Cleaning",
  out_of_service: "Out of service",
};

// Color tokens the floor plan and any other status badge should use —
// centralized here so a status's meaning and its color can't drift apart
// across components (same reasoning as ORDER_STATUS_LABELS living next to
// the state machine rather than being redefined per-component).
export const TABLE_STATUS_COLORS: Record<TableStatus, { bg: string; text: string; dot: string }> = {
  available: { bg: "bg-green-50", text: "text-green-700", dot: "bg-green-500" },
  ordering: { bg: "bg-blue-50", text: "text-blue-700", dot: "bg-blue-500" },
  occupied: { bg: "bg-orange-50", text: "text-orange-700", dot: "bg-orange-500" },
  reserved: { bg: "bg-purple-50", text: "text-purple-700", dot: "bg-purple-500" },
  payment_pending: { bg: "bg-amber-50", text: "text-amber-700", dot: "bg-amber-500" },
  cleaning: { bg: "bg-sky-50", text: "text-sky-700", dot: "bg-sky-500" },
  out_of_service: { bg: "bg-neutral-100", text: "text-neutral-500", dot: "bg-neutral-400" },
};

/**
 * The only transitions a staff member drives directly via a manual status
 * PATCH — see the table status route. Everything else in TABLE_STATUSES is
 * reachable only through order/reservation activity (deriveTableStatus in
 * src/lib/tables.ts) and is rejected here so the two mechanisms can't fight
 * each other (e.g. a manual PATCH can't be used to fake "occupied").
 */
const MANUAL_TRANSITIONS: Record<TableStatus, TableStatus[]> = {
  // "ordering" is staff opening a table (from the floor plan or POS) to
  // start building an order — from either a free table or one already
  // held by a reservation (the reserved party has arrived and staff are
  // keying in their order directly, without a separate "mark seated" step
  // first).
  available: ["ordering", "out_of_service"],
  reserved: ["ordering", "out_of_service"],
  // Backing out of "ordering" without submitting an order releases the
  // table; submitting one advances it to "occupied" automatically via
  // syncTableStatusFromOrders (a system transition, not this manual table).
  ordering: ["available", "out_of_service"],
  occupied: ["out_of_service"],
  payment_pending: ["out_of_service"],
  cleaning: ["available", "out_of_service"],
  out_of_service: ["available"],
};

export function canManuallyTransition(from: TableStatus, to: TableStatus): boolean {
  return MANUAL_TRANSITIONS[from].includes(to);
}

export function manualNextStatuses(from: TableStatus): TableStatus[] {
  return MANUAL_TRANSITIONS[from];
}

/**
 * Pure derivation: given counts of a table's current orders by bucket,
 * what should its status be? Split into three buckets rather than raw order
 * statuses so the caller (src/lib/tables.ts) can query cheaply with a single
 * grouped count and this function stays trivially unit-testable with no DB.
 *
 * - kitchenActive: pending/confirmed/preparing/ready — something on this
 *   table still needs kitchen/staff attention.
 * - served: served — delivered, but the order hasn't been marked completed
 *   (i.e. the bill hasn't been settled/closed out) yet.
 * - completed: completed — at least one order for this table was fully
 *   closed out. (cancelled orders aren't counted in any bucket — a
 *   cancelled-only table has kitchenActive=served=completed=0 and falls
 *   through to "available", which is exactly "release the table.")
 */
export function deriveTableStatus(counts: {
  kitchenActive: number;
  served: number;
  completed: number;
}): TableStatus {
  if (counts.kitchenActive > 0) return "occupied";
  if (counts.served > 0) return "payment_pending";
  if (counts.completed > 0) return "cleaning";
  return "available";
}
