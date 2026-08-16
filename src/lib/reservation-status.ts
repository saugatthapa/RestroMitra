/**
 * The reservation lifecycle state machine — Phase 8d. Deliberately a
 * plain, dependency-free module (no "server-only", no DB import), same
 * pattern as order-status.ts, so it's shared unmodified between the API
 * route and the dashboard UI.
 */

export const RESERVATION_STATUSES = [
  "requested",
  "confirmed",
  "seated",
  "completed",
  "cancelled",
  "no_show",
] as const;

export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export const RESERVATION_STATUS_LABELS: Record<ReservationStatus, string> = {
  requested: "Requested",
  confirmed: "Confirmed",
  seated: "Seated",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "No-show",
};

/**
 * Allowed forward transitions. A booking can be cancelled any time before
 * the party has actually been seated (after that, "cancel" doesn't make
 * sense — they're either dining or already gone). "no_show" is only
 * reachable from "confirmed" — an unconfirmed request that never gets a
 * reply is just left as "requested" or explicitly cancelled, not marked a
 * no-show (they never had a firm booking to miss). completed/cancelled/
 * no_show are terminal — nothing transitions out of them here.
 */
const TRANSITIONS: Record<ReservationStatus, ReservationStatus[]> = {
  requested: ["confirmed", "cancelled"],
  confirmed: ["seated", "cancelled", "no_show"],
  seated: ["completed"],
  completed: [],
  cancelled: [],
  no_show: [],
};

export function nextStatuses(from: ReservationStatus): ReservationStatus[] {
  return TRANSITIONS[from];
}

export function canTransition(from: ReservationStatus, to: ReservationStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminalStatus(status: ReservationStatus): boolean {
  return TRANSITIONS[status].length === 0;
}
