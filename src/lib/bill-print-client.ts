/**
 * Opens the narrow, thermal-receipt-style customer bill in a small popup —
 * mirrors openKotTicket in kot-print-client.ts exactly (same reasoning:
 * the page itself auto-triggers window.print()/direct thermal printing the
 * instant its data loads, so from the cashier's perspective clicking
 * "Print bill" just prints). Kept as its own file rather than added to
 * kot-print-client.ts since it prints a different document to a different
 * route — no shared logic beyond the popup-opening shape itself.
 */
export function openBillReceipt(orderId: string) {
  if (typeof window === "undefined") return;
  window.open(
    `/print/bill/${orderId}`,
    `bill-${orderId}`,
    "noopener,width=420,height=720,menubar=no,toolbar=no,location=no",
  );
}
