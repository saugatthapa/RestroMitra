"use client";

import { useEffect, useState } from "react";
import { apiGet, ApiError } from "@/lib/api-client";
import { buildKotStationTickets, resolveKotHeaderText, type KotTicketItem } from "@/lib/kot-ticket";

type Order = {
  id: string;
  orderNumber: string;
  kotSequence: number | null;
  placedAt: string;
  customerName: string | null;
  notes: string | null;
  table: { id: string; name: string } | null;
  items: KotTicketItem[];
};

function base(slug: string) {
  return `/api/restaurants/${slug}`;
}

/**
 * The actual printable ticket — station-grouped, narrow (thermal-printer
 * width), and auto-triggers window.print() the instant its data loads (see
 * openKotTicket in kot-print-client.ts, which opens this page in a small
 * popup right after a pending -> confirmed transition). Reachable directly
 * too (e.g. from an order's detail page) for a manual reprint — reprinting
 * never reassigns the ticket number (assignKotSequence is idempotent), so
 * every copy of a given order's ticket shows the same #N.
 */
export function KotTicketView({
  slug,
  orderId,
  restaurantName,
  kotHeaderText,
}: {
  slug: string;
  orderId: string;
  restaurantName: string;
  kotHeaderText: string | null;
}) {
  const [order, setOrder] = useState<Order | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasAutoPrinted, setHasAutoPrinted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await apiGet<{ order: Order }>(`${base(slug)}/orders/${orderId}`);
        if (!cancelled) setOrder(res.order);
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof ApiError ? err.message : "Could not load this order.");
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [slug, orderId]);

  useEffect(() => {
    if (!order || hasAutoPrinted) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHasAutoPrinted(true);
    // A short delay lets the browser finish painting the ticket before the
    // print dialog steals focus — printing mid-layout can clip content on
    // some browsers.
    const timer = setTimeout(() => window.print(), 150);
    return () => clearTimeout(timer);
  }, [order, hasAutoPrinted]);

  if (loadError) {
    return <p className="p-6 text-sm text-red-700">{loadError}</p>;
  }
  if (!order) {
    return <p className="p-6 text-sm text-neutral-500">Loading ticket…</p>;
  }

  const headerText = resolveKotHeaderText({ name: restaurantName, kotHeaderText });
  const stationTickets = buildKotStationTickets(order.items);

  return (
    <div className="mx-auto max-w-sm p-4">
      <div className="mb-4 flex items-center justify-between print:hidden">
        <p className="text-xs text-neutral-500">Kitchen Order Ticket — Order #{order.orderNumber}</p>
        <button onClick={() => window.print()} className="btn-secondary text-xs">
          Reprint
        </button>
      </div>

      {stationTickets.length === 0 ? (
        <p className="text-sm text-neutral-400 print:hidden">This order has no items.</p>
      ) : (
        <div className="space-y-6">
          {stationTickets.map((ticket, index) => (
            <div
              key={ticket.station.id}
              className="border border-dashed border-neutral-300 p-3 font-mono text-xs"
              // One physical ticket per station — force each onto its own
              // printed page/sheet rather than letting them run together.
              style={index < stationTickets.length - 1 ? { breakAfter: "page" } : undefined}
            >
              <div className="mb-2 text-center">
                <p className="text-sm font-bold uppercase">{headerText}</p>
                <p className="text-[11px] text-neutral-500">Kitchen Order Ticket</p>
              </div>
              <div className="mb-2 flex items-center justify-between border-y border-dashed border-neutral-400 py-1">
                <span className="font-bold">Ticket #{order.kotSequence ?? "—"}</span>
                <span className="font-bold">{ticket.station.name}</span>
              </div>
              <p>Order #{order.orderNumber}</p>
              <p>
                {order.table ? order.table.name : "Takeaway"}
                {order.customerName ? ` · ${order.customerName}` : ""}
              </p>
              <p>{new Date(order.placedAt).toLocaleString("en-NP")}</p>
              <div className="my-2 border-t border-dashed border-neutral-300" />
              <div className="space-y-1.5">
                {ticket.items.map((item) => (
                  <div key={item.id}>
                    <p className="font-semibold">
                      {item.quantity} × {item.menuItemNameSnapshot}
                      {item.variantNameSnapshot ? ` (${item.variantNameSnapshot})` : ""}
                    </p>
                    {item.addons.length > 0 && (
                      <p className="pl-3 text-neutral-600">
                        + {item.addons.map((a) => a.nameSnapshot).join(", ")}
                      </p>
                    )}
                    {item.notes && <p className="pl-3 italic text-neutral-600">Note: {item.notes}</p>}
                  </div>
                ))}
              </div>
              {order.notes && (
                <div className="mt-2 border-t border-dashed border-neutral-300 pt-2 italic">
                  Order notes: {order.notes}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
