"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, ApiError } from "@/lib/api-client";
import { formatNPR } from "@/lib/money";
import { useDateSystem } from "@/lib/date-system";
import { formatDate } from "@/lib/nepali-date";
import { buildBillEscPos, type EscPosBillItem } from "@/lib/printing/escpos";
import {
  forgetPairedPrinter,
  getStoredPrinterLabel,
  isWebSerialSupported,
  pairPrinter,
  printToThermalPrinter,
  resolvePairedPort,
} from "@/lib/printing/web-serial-printer";

const PRINT_MODE_KEY = "restromitra:bill-print-mode";

type OrderItem = {
  id: string;
  menuItemNameSnapshot: string;
  variantNameSnapshot: string | null;
  quantity: number;
  lineTotalInPaisa: number;
};
type Order = {
  orderNumber: string;
  fiscalInvoiceNumber: number | null;
  placedAt: string;
  customerName: string | null;
  table: { name: string } | null;
  restaurant: {
    name: string;
    phone: string | null;
    address: string | null;
    city: string | null;
    district: string | null;
    panNumber: string | null;
    vatNumber: string | null;
  };
  items: OrderItem[];
  subtotalInPaisa: number;
  discountType: "percentage" | "flat" | null;
  discountValue: number | null;
  discountInPaisa: number;
  discountReason: string | null;
  serviceChargeBasisPoints: number;
  serviceChargeInPaisa: number;
  taxInPaisa: number;
  totalInPaisa: number;
};
type Billing = {
  netPaidInPaisa: number;
  remainingDueInPaisa: number;
  tipTotalInPaisa: number;
};

function base(slug: string) {
  return `/api/restaurants/${slug}`;
}

/**
 * The actual printable bill — narrow (thermal-printer width), same overall
 * scaffolding as KotTicketView.tsx (auto-print on load, Web Serial direct
 * thermal printing with a browser-print fallback). Reachable via
 * openBillReceipt (bill-print-client.ts), which OrderBillView's "Print
 * bill" button now opens instead of calling window.print() on itself —
 * that on-screen view stays a normal wide page for managing the order;
 * this page is the one that actually goes to the counter printer.
 */
export function BillReceiptView({ slug, orderId }: { slug: string; orderId: string }) {
  const [order, setOrder] = useState<Order | null>(null);
  const [billing, setBilling] = useState<Billing | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasAutoPrinted, setHasAutoPrinted] = useState(false);
  const dateSystem = useDateSystem();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await apiGet<{ order: Order; billing: Billing }>(`${base(slug)}/orders/${orderId}`);
        if (!cancelled) {
          setOrder(res.order);
          setBilling(res.billing);
        }
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

  // Same Web Serial direct-thermal-printing setup as KotTicketView — see
  // that component's own comment for the full reasoning. Kept as a
  // separate localStorage key (bill vs. KOT print mode) since a restaurant
  // may pair one printer for kitchen tickets and a different one at the
  // counter for bills, or want one direct and the other via the dialog.
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
    const result = await pairPrinter("Bill printer");
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
    if (!order || !billing) return false;
    const infoLines = [
      order.restaurant.address,
      [order.restaurant.city, order.restaurant.district].filter(Boolean).join(", "),
      order.restaurant.phone ? `Tel: ${order.restaurant.phone}` : null,
    ].filter((line): line is string => !!line && line.trim().length > 0);

    const items: EscPosBillItem[] = order.items.map((item) => ({
      quantity: item.quantity,
      name: item.menuItemNameSnapshot,
      variantName: item.variantNameSnapshot,
      lineTotal: formatNPR(item.lineTotalInPaisa),
    }));

    const bytes = buildBillEscPos({
      restaurantName: order.restaurant.name,
      infoLines,
      panNumber: order.restaurant.panNumber,
      vatNumber: order.restaurant.vatNumber,
      orderNumber: order.orderNumber,
      fiscalInvoiceNumber: order.fiscalInvoiceNumber,
      tableOrTakeaway: order.table ? order.table.name : "Takeaway",
      customerName: order.customerName,
      placedAt: new Date(order.placedAt).toLocaleString("en-NP"),
      items,
      subtotal: formatNPR(order.subtotalInPaisa),
      discount:
        order.discountInPaisa > 0
          ? {
              label:
                "Discount" +
                (order.discountType === "percentage" && order.discountValue
                  ? ` (${(order.discountValue / 100).toFixed(2)}%)`
                  : "") +
                (order.discountReason ? ` - ${order.discountReason}` : ""),
              amount: formatNPR(order.discountInPaisa),
            }
          : null,
      serviceCharge:
        order.serviceChargeInPaisa > 0
          ? {
              label: `Service charge (${(order.serviceChargeBasisPoints / 100).toFixed(2)}%)`,
              amount: formatNPR(order.serviceChargeInPaisa),
            }
          : null,
      tax: formatNPR(order.taxInPaisa),
      total: formatNPR(order.totalInPaisa),
      paid: formatNPR(billing.netPaidInPaisa),
      tip: billing.tipTotalInPaisa > 0 ? formatNPR(billing.tipTotalInPaisa) : null,
      remainingDue: formatNPR(billing.remainingDueInPaisa),
    });

    const result = await printToThermalPrinter(bytes);
    if (!result.ok) {
      setPrinterError(result.error);
      return false;
    }
    return true;
  }, [order, billing]);

  const triggerPrint = useCallback(async () => {
    if (thermalMode && printerReady) {
      const ok = await printThermal();
      if (ok) return;
      // Same fallback reasoning as the KOT ticket — a failed direct print
      // (printer off, cable pulled) still needs the bill to reach the
      // customer somehow, so fall through to the browser dialog.
    }
    window.print();
  }, [thermalMode, printerReady, printThermal]);

  useEffect(() => {
    if (!order || !billing || hasAutoPrinted) return;
    setHasAutoPrinted(true);
    const timer = setTimeout(() => triggerPrint(), 150);
    return () => clearTimeout(timer);
  }, [order, billing, hasAutoPrinted, triggerPrint]);

  if (loadError) {
    return <p className="p-6 text-sm text-red-700">{loadError}</p>;
  }
  if (!order || !billing) {
    return <p className="p-6 text-sm text-neutral-500">Loading bill…</p>;
  }

  const addressLine = [order.restaurant.city, order.restaurant.district].filter(Boolean).join(", ");

  return (
    <div className="mx-auto max-w-sm p-4">
      <div className="mb-2 flex items-center justify-between print:hidden">
        <p className="text-xs text-neutral-500">Bill — Order #{order.orderNumber}</p>
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

      <div className="border border-dashed border-neutral-300 p-3 font-mono text-xs">
        <div className="mb-2 text-center">
          <p className="text-sm font-bold uppercase">{order.restaurant.name}</p>
          {order.restaurant.address && <p className="text-[11px] text-neutral-500">{order.restaurant.address}</p>}
          {addressLine && <p className="text-[11px] text-neutral-500">{addressLine}</p>}
          {order.restaurant.phone && <p className="text-[11px] text-neutral-500">Tel: {order.restaurant.phone}</p>}
          {(order.restaurant.panNumber || order.restaurant.vatNumber) && (
            <p className="text-[11px] text-neutral-500">
              {order.restaurant.panNumber ? `PAN: ${order.restaurant.panNumber}` : ""}
              {order.restaurant.panNumber && order.restaurant.vatNumber ? "  " : ""}
              {order.restaurant.vatNumber ? `VAT: ${order.restaurant.vatNumber}` : ""}
            </p>
          )}
        </div>
        <div className="my-2 border-t border-dashed border-neutral-400" />
        <p>Order #{order.orderNumber}</p>
        {order.fiscalInvoiceNumber !== null && <p>Fiscal Invoice #{order.fiscalInvoiceNumber}</p>}
        <p>
          {order.table ? order.table.name : "Takeaway"}
          {order.customerName ? ` · ${order.customerName}` : ""}
        </p>
        <p>{formatDate(order.placedAt, dateSystem, { withTime: true })}</p>
        <div className="my-2 border-t border-dashed border-neutral-300" />
        <div className="space-y-1">
          {order.items.map((item) => (
            <div key={item.id} className="flex justify-between gap-2">
              <span>
                {item.quantity} × {item.menuItemNameSnapshot}
                {item.variantNameSnapshot ? ` (${item.variantNameSnapshot})` : ""}
              </span>
              <span className="shrink-0">{formatNPR(item.lineTotalInPaisa)}</span>
            </div>
          ))}
        </div>
        <div className="my-2 border-t border-dashed border-neutral-300" />
        <div className="space-y-0.5">
          <div className="flex justify-between">
            <span>Subtotal</span>
            <span>{formatNPR(order.subtotalInPaisa)}</span>
          </div>
          {order.discountInPaisa > 0 && (
            <div className="flex justify-between">
              <span>
                Discount
                {order.discountType === "percentage" && order.discountValue
                  ? ` (${(order.discountValue / 100).toFixed(2)}%)`
                  : ""}
              </span>
              <span>-{formatNPR(order.discountInPaisa)}</span>
            </div>
          )}
          {order.serviceChargeInPaisa > 0 && (
            <div className="flex justify-between">
              <span>Service charge ({(order.serviceChargeBasisPoints / 100).toFixed(2)}%)</span>
              <span>{formatNPR(order.serviceChargeInPaisa)}</span>
            </div>
          )}
          <div className="flex justify-between">
            <span>Tax</span>
            <span>{formatNPR(order.taxInPaisa)}</span>
          </div>
          <div className="my-1 border-t border-dashed border-neutral-400" />
          <div className="flex justify-between font-bold">
            <span>Total</span>
            <span>{formatNPR(order.totalInPaisa)}</span>
          </div>
          <div className="flex justify-between">
            <span>Paid</span>
            <span>{formatNPR(billing.netPaidInPaisa)}</span>
          </div>
          {billing.tipTotalInPaisa > 0 && (
            <div className="flex justify-between">
              <span>Tip (not part of bill)</span>
              <span>{formatNPR(billing.tipTotalInPaisa)}</span>
            </div>
          )}
          <div className="flex justify-between font-bold">
            <span>Remaining due</span>
            <span>{formatNPR(billing.remainingDueInPaisa)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
