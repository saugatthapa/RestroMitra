/**
 * The order lifecycle state machine — Phase 4's core addition. Deliberately
 * a plain, dependency-free module (no "server-only", no DB import) so it's
 * trivially unit-testable and importable from both API routes and client
 * components (the dashboard UI needs the same labels/transition rules to
 * decide which action buttons to show).
 *
 * Every order (regardless of source — qr_customer today, pos/waiter once
 * Phase 5 ships) moves through this SAME state machine. That's what makes
 * this a "centralized" order engine rather than a QR-specific one.
 */

export const ORDER_STATUSES = [
  "pending",
  "confirmed",
  "preparing",
  "ready",
  "served",
  "completed",
  "cancelled",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  pending: "New",
  confirmed: "Confirmed",
  preparing: "Preparing",
  ready: "Ready",
  served: "Served",
  completed: "Completed",
  cancelled: "Cancelled",
};

/**
 * Allowed forward transitions. Cancellation is allowed any time before the
 * order has actually been served (after that, "cancel" doesn't make sense
 * — a served order that goes wrong is a refund, which is
 * PERMISSIONS.REFUND_ORDER / Phase 5 POS territory, not a status flip).
 * completed/cancelled are terminal — nothing transitions out of them here;
 * corrections after that point are an audited refund/void action, not a
 * silent status edit.
 */
const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["preparing", "cancelled"],
  preparing: ["ready", "cancelled"],
  ready: ["served", "cancelled"],
  served: ["completed"],
  completed: [],
  cancelled: [],
};

export function nextStatuses(from: OrderStatus): OrderStatus[] {
  return TRANSITIONS[from];
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminalStatus(status: OrderStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** The single forward "advance" action for a status, if one exists (excludes cancellation). */
export function nextForwardStatus(from: OrderStatus): OrderStatus | null {
  return TRANSITIONS[from].find((s) => s !== "cancelled") ?? null;
}
