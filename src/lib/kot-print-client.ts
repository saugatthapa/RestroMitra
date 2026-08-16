/**
 * Phase 17 — opens the Kitchen Order Ticket print page in a small popup
 * window right after a pending -> confirmed transition succeeds. This is
 * as close to "auto-print" as a browser app can honestly get: the ticket
 * page itself calls window.print() the instant its data loads (see
 * KotTicketView.tsx), so from the staff member's perspective, confirming
 * an order pops the OS print dialog open on its own — there's just no way
 * for a web page to skip that dialog and silently drive a physical printer
 * without a native helper app, which is out of scope here.
 *
 * Deliberately a plain function (not a hook) so it's a one-line addition
 * at every call site (OrdersBoard, OrderBillView) rather than a new
 * component wrapping each of them.
 */
export function openKotTicket(orderId: string) {
  if (typeof window === "undefined") return;
  window.open(
    `/print/kot/${orderId}`,
    `kot-${orderId}`,
    "noopener,width=420,height=720,menubar=no,toolbar=no,location=no",
  );
}
