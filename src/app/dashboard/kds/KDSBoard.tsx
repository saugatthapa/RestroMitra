"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { apiGet, apiPatch, ApiError } from "@/lib/api-client";
import {
  KDS_VISIBLE_STATUSES,
  distinctStations,
  itemsForStation,
  UNASSIGNED_STATION_ID,
  type StationRef,
} from "@/lib/kds";
import { type OrderStatus } from "@/lib/order-status";
import { StatIcon } from "@/components/StatTile";

type OrderItemAddon = { id: string; nameSnapshot: string; priceInPaisaSnapshot: number };
type OrderItem = {
  id: string;
  menuItemNameSnapshot: string;
  variantNameSnapshot: string | null;
  quantity: number;
  notes: string | null;
  kitchenStationId: string | null;
  kitchenStationNameSnapshot: string | null;
  addons: OrderItemAddon[];
};
type Order = {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  customerName: string | null;
  placedAt: string;
  table: { id: string; name: string } | null;
  items: OrderItem[];
};

const KDS_COLUMNS: OrderStatus[] = ["confirmed", "preparing", "ready"];
const COLUMN_LABELS: Record<string, string> = {
  confirmed: "Waiting to start",
  preparing: "In progress",
  ready: "Ready",
};
// Which status a kitchen ticket's single action button moves it to, per
// current status — mirrors isKitchenTransition in src/lib/kds.ts. "ready"
// has no button: front-of-house serves from there, not the kitchen.
const KITCHEN_ADVANCE: Partial<Record<OrderStatus, { to: OrderStatus; label: string }>> = {
  confirmed: { to: "preparing", label: "Start preparing" },
  preparing: { to: "ready", label: "Mark ready" },
};

function base(slug: string) {
  return `/api/restaurants/${slug}`;
}

function elapsedSince(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ago`;
}

// Urgency thresholds — how long since the ticket was placed, not since it
// entered its current column, so a ticket that's been sitting since
// "confirmed" stays visibly urgent even after it moves to "preparing".
// Kept as plain minute cutoffs (not configurable per restaurant yet) —
// the same conservative "ship the common case, note the gap" approach as
// the rest of KDS.
const URGENCY_WARNING_MINUTES = 10;
const URGENCY_CRITICAL_MINUTES = 15;

type Urgency = "normal" | "warning" | "critical";

function urgencyOf(iso: string): Urgency {
  const minutes = (Date.now() - new Date(iso).getTime()) / 60_000;
  if (minutes >= URGENCY_CRITICAL_MINUTES) return "critical";
  if (minutes >= URGENCY_WARNING_MINUTES) return "warning";
  return "normal";
}

// Color never carries urgency alone — the elapsed-time text itself already
// says "17m ago", color is a reinforcing, glance-from-across-the-kitchen
// signal on top of that, not a replacement for it.
const URGENCY_CARD_CLASS: Record<Urgency, string> = {
  normal: "border-neutral-200 bg-neutral-50",
  warning: "border-amber-300 bg-amber-50",
  critical: "border-red-300 bg-red-50",
};
const URGENCY_TIMER_CLASS: Record<Urgency, string> = {
  normal: "text-neutral-400",
  warning: "font-semibold text-amber-700",
  critical: "font-semibold text-red-700",
};

export function KDSBoard({ slug, canAdvance }: { slug: string; canAdvance: boolean }) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyOrderId, setBusyOrderId] = useState<string | null>(null);
  const [selectedStationId, setSelectedStationId] = useState<string | "all">("all");
  // Re-render every 30s just to refresh "Xm ago" labels between polls.
  const [, forceTick] = useState(0);

  async function load() {
    try {
      const res = await apiGet<{ orders: Order[] }>(`${base(slug)}/orders`);
      setOrders(res.orders.filter((o) => KDS_VISIBLE_STATUSES.includes(o.status)));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load tickets.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Mount-time fetch plus polling — same pattern as OrdersBoard.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    const poll = setInterval(load, 5000);
    const tick = setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  const stations = useMemo(
    () => distinctStations(orders.flatMap((o) => o.items)),
    [orders],
  );

  async function advance(order: Order, to: OrderStatus) {
    setBusyOrderId(order.id);
    try {
      const res = await apiPatch<{ order: Order }>(`${base(slug)}/orders/${order.id}/status`, {
        status: to,
      });
      setOrders((prev) =>
        KDS_VISIBLE_STATUSES.includes(res.order.status)
          ? prev.map((o) => (o.id === order.id ? { ...o, ...res.order } : o))
          : prev.filter((o) => o.id !== order.id),
      );
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not update the ticket.");
    } finally {
      setBusyOrderId(null);
    }
  }

  if (loading) {
    return <p className="text-sm text-neutral-500">Loading tickets…</p>;
  }

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setSelectedStationId("all")}
          className={`rounded-full border px-3 py-1.5 text-sm ${
            selectedStationId === "all"
              ? "border-orange-600 bg-orange-50 font-medium text-orange-700"
              : "border-neutral-200 text-neutral-600"
          }`}
        >
          All stations
        </button>
        {stations.map((s: StationRef) => (
          <button
            key={s.id}
            onClick={() => setSelectedStationId(s.id)}
            className={`rounded-full border px-3 py-1.5 text-sm ${
              selectedStationId === s.id
                ? "border-orange-600 bg-orange-50 font-medium text-orange-700"
                : "border-neutral-200 text-neutral-600"
            }`}
          >
            {s.name}
          </button>
        ))}

        <div className="ml-auto flex items-center gap-3 text-[11px] text-neutral-400">
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-amber-400" aria-hidden="true" />
            {URGENCY_WARNING_MINUTES}m+
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-red-400" aria-hidden="true" />
            {URGENCY_CRITICAL_MINUTES}m+
          </span>
        </div>
      </div>

      {orders.length === 0 ? (
        <p className="text-sm text-neutral-400">No active tickets right now.</p>
      ) : (
        // QA hardening pass: this used to jump to 3 columns at `sm` (640px)
        // — fine on a phone in landscape, but on a tablet held in portrait
        // (768–1023px) the always-visible 240px sidebar (see
        // DashboardShell) left so little room per column that ticket IDs
        // and column headers wrapped mid-word, exactly the kind of
        // glance-and-go readability a kitchen counter can't afford. Two
        // columns from `sm`, three only once there's genuinely enough width
        // (`lg`, 1024px) for each ticket to stay comfortably readable.
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {KDS_COLUMNS.map((status) => {
            const columnOrders = orders
              .filter((o) => o.status === status)
              .filter((o) =>
                selectedStationId === "all"
                  ? true
                  : itemsForStation(o.items, selectedStationId).length > 0,
              )
              .sort((a, b) => new Date(a.placedAt).getTime() - new Date(b.placedAt).getTime());
            const advanceAction = KITCHEN_ADVANCE[status];

            return (
              <div key={status} className="rounded-2xl border border-neutral-200 bg-white p-3">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-sm font-semibold text-neutral-900">
                    {COLUMN_LABELS[status]}
                  </p>
                  <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-500">
                    {columnOrders.length}
                  </span>
                </div>

                <div className="space-y-2">
                  {columnOrders.length === 0 && (
                    <p className="text-xs text-neutral-400">Nothing here.</p>
                  )}
                  {columnOrders.map((order) => {
                    const ticketItems =
                      selectedStationId === "all"
                        ? order.items
                        : itemsForStation(order.items, selectedStationId);
                    const busy = busyOrderId === order.id;
                    const urgency = urgencyOf(order.placedAt);

                    return (
                      <div
                        key={order.id}
                        className={`rounded-xl border p-3 text-xs transition-colors ${URGENCY_CARD_CLASS[urgency]}`}
                      >
                        <div className="mb-1 flex items-center justify-between">
                          <Link
                            href={`/dashboard/orders/${order.id}`}
                            className="font-semibold text-neutral-900 hover:text-orange-700 hover:underline"
                          >
                            #{order.orderNumber}
                          </Link>
                          <span className={`inline-flex items-center gap-1 ${URGENCY_TIMER_CLASS[urgency]}`}>
                            {urgency !== "normal" && (
                              <span className="flex h-3 w-3 shrink-0 items-center justify-center">
                                <StatIcon.Clock />
                              </span>
                            )}
                            {elapsedSince(order.placedAt)}
                          </span>
                        </div>
                        <p className="text-neutral-500">
                          {order.table ? order.table.name : "Takeaway"}
                          {order.customerName ? ` · ${order.customerName}` : ""}
                        </p>
                        <ul className="mt-1 space-y-1 text-neutral-700">
                          {ticketItems.map((item) => (
                            <li key={item.id}>
                              <span className="font-medium">
                                {item.quantity}× {item.menuItemNameSnapshot}
                                {item.variantNameSnapshot ? ` (${item.variantNameSnapshot})` : ""}
                              </span>
                              {item.addons.length > 0 && (
                                <span className="text-neutral-500">
                                  {" "}
                                  — {item.addons.map((a) => a.nameSnapshot).join(", ")}
                                </span>
                              )}
                              {item.notes && (
                                <span className="block italic text-neutral-400">
                                  {item.notes}
                                </span>
                              )}
                              {selectedStationId === "all" &&
                                item.kitchenStationNameSnapshot &&
                                stations.length > 1 && (
                                  <span className="ml-1 rounded-full bg-neutral-200 px-1.5 py-0.5 text-[10px] text-neutral-600">
                                    {item.kitchenStationNameSnapshot}
                                  </span>
                                )}
                            </li>
                          ))}
                        </ul>

                        {advanceAction && canAdvance && (
                          <button
                            disabled={busy}
                            onClick={() => advance(order, advanceAction.to)}
                            className="mt-2 rounded-full bg-orange-600 px-2.5 py-1 text-[11px] font-semibold text-white disabled:opacity-50"
                          >
                            {advanceAction.label}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {stations.some((s) => s.id === UNASSIGNED_STATION_ID) && (
        <p className="text-xs text-neutral-400">
          &quot;Unassigned&quot; items have no kitchen station set on the menu — assign one from
          the Menu page so they group correctly here.
        </p>
      )}
    </div>
  );
}
