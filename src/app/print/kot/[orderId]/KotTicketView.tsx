"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, ApiError } from "@/lib/api-client";
import { buildKotStationTickets, resolveKotHeaderText, type KotTicketItem } from "@/lib/kot-ticket";
import { buildKotTicketEscPos } from "@/lib/printing/escpos";
import {
  forgetPairedPrinter,
  getStoredPrinterLabel,
  isWebSerialSupported,
  pairPrinter,
  printToThermalPrinter,
  resolvePairedPort,
} from "@/lib/printing/web-serial-printer";

const PRINT_MODE_KEY = "restromitra:kot-print-mode";

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

  // Direct thermal printing (Phase 23) — see web-serial-printer.ts for the
  // full reasoning. `printerReady` null = still checking, true/false = the
  // paired printer resolved (or didn't) WITHOUT prompting anyone, since
  // that check runs on mount rather than from a click. `thermalMode` is a
  // per-device preference (localStorage, not per-restaurant) — printing
  // hardware is plugged into one physical machine, not tied to who's
  // logged in on it.
  const [webSerialSupported] = useState(() => isWebSerialSupported());
  const [printerLabel, setPrinterLabel] = useState<string | null>(null);
  const [printerReady, setPrinterReady] = useState<boolean | null>(null);
  const [thermalMode, setThermalMode] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [printerError, setPrinterError] = useState<string | null>(null);

  useEffect(() => {
    if (!webSerialSupported) return;
    setPrinterLabel(getStoredPrinterLabel());
    if (typeof window !== "undefined") {
      setThermalMode(window.localStorage.getItem(PRINT_MODE_KEY) === "thermal");
    }
    resolvePairedPort()
      .then((port) => setPrinterReady(!!port))
      .catch(() => setPrinterReady(false));
  }, [webSerialSupported]);

  function setMode(mode: "browser" | "thermal") {
    setThermalMode(mode === "thermal");
    if (typeof window !== "undefined") window.localStorage.setItem(PRINT_MODE_KEY, mode);
  }

  async function handlePair() {
    setPairing(true);
    setPrinterError(null);
    const result = await pairPrinter("Kitchen printer");
    setPairing(false);
    if (result.ok) {
      setPrinterLabel(getStoredPrinterLabel());
      setPrinterReady(true);
      setMode("thermal");
    } else {
      setPrinterError(result.error);
    }
  }

  function handleForget() {
    forgetPairedPrinter();
    setPrinterLabel(null);
    setPrinterReady(false);
    setMode("browser");
  }

  const printThermal = useCallback(async (): Promise<boolean> => {
    if (!order) return false;
    const headerText = resolveKotHeaderText({ name: restaurantName, kotHeaderText });
    const stationTickets = buildKotStationTickets(order.items);
    const placedAtText = new Date(order.placedAt).toLocaleString("en-NP");
    const tableOrTakeaway = order.table ? order.table.name : "Takeaway";

    for (const ticket of stationTickets) {
      const bytes = buildKotTicketEscPos({
        headerText,
        stationName: ticket.station.name,
        kotSequence: order.kotSequence,
        orderNumber: order.orderNumber,
        tableOrTakeaway,
        customerName: order.customerName,
        placedAt: placedAtText,
        orderNotes: order.notes,
        items: ticket.items.map((item) => ({
          quantity: item.quantity,
          name: item.menuItemNameSnapshot,
          variantName: item.variantNameSnapshot,
          addonNames: item.addons.map((a) => a.nameSnapshot),
          notes: item.notes,
        })),
      });
      const result = await printToThermalPrinter(bytes);
      if (!result.ok) {
        setPrinterError(result.error);
        return false;
      }
    }
    return true;
  }, [order, restaurantName, kotHeaderText]);

  const triggerPrint = useCallback(async () => {
    if (thermalMode && printerReady) {
      const ok = await printThermal();
      if (ok) return;
      // A failed direct print (printer off, unplugged, cable pulled) still
      // needs the ticket to reach the kitchen somehow — fall through to
      // the browser dialog rather than silently losing the ticket.
    }
    window.print();
  }, [thermalMode, printerReady, printThermal]);

  useEffect(() => {
    if (!order || hasAutoPrinted) return;
    setHasAutoPrinted(true);
    // A short delay lets the browser finish painting the ticket before
    // printing — for the browser-dialog path this avoids the dialog
    // stealing focus mid-layout; for the direct thermal path it just
    // keeps both paths on the same predictable rhythm.
    const timer = setTimeout(() => triggerPrint(), 150);
    return () => clearTimeout(timer);
  }, [order, hasAutoPrinted, triggerPrint]);

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
      <div className="mb-2 flex items-center justify-between print:hidden">
        <p className="text-xs text-neutral-500">Kitchen Order Ticket — Order #{order.orderNumber}</p>
        <button onClick={() => triggerPrint()} className="btn-secondary text-xs">
          Reprint
        </button>
      </div>

      {webSerialSupported && (
        <div className="mb-4 rounded-lg border border-neutral-200 bg-neutral-50 p-2.5 text-xs print:hidden">
          {printerLabel && printerReady ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-neutral-600">
                🖨️ <span className="font-medium text-neutral-900">{printerLabel}</span> paired
              </span>
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1.5 text-neutral-600">
                  <input
                    type="checkbox"
                    checked={thermalMode}
                    onChange={(e) => setMode(e.target.checked ? "thermal" : "browser")}
                  />
                  Print directly (skip dialog)
                </label>
                <button onClick={handleForget} className="text-neutral-400 underline">
                  Forget
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <span className="text-neutral-500">
                {printerLabel
                  ? "Paired printer not found — check it's plugged in and turned on."
                  : "No thermal printer connected on this device."}
              </span>
              <button onClick={handlePair} disabled={pairing} className="btn-secondary text-xs">
                {pairing ? "Connecting…" : "Pair printer"}
              </button>
            </div>
          )}
          {printerError && <p className="mt-1.5 text-red-600">{printerError}</p>}
        </div>
      )}

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
