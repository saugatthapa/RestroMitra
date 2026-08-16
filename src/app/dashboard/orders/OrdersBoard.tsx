"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiGet, apiPatch, ApiError } from "@/lib/api-client";
import { formatNPR } from "@/lib/money";
import {
  ORDER_STATUS_LABELS,
  nextForwardStatus,
  canTransition,
  type OrderStatus,
} from "@/lib/order-status";
import { openKotTicket } from "@/lib/kot-print-client";

type OrderItemAddon = { id: string; nameSnapshot: string; priceInPaisaSnapshot: number };
type OrderItem = {
  id: string;
  menuItemNameSnapshot: string;
  variantNameSnapshot: string | null;
  quantity: number;
  lineTotalInPaisa: number;
  addons: OrderItemAddon[];
};
type Order = {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  source: string;
  customerName: string | null;
  customerPhone: string | null;
  notes: string | null;
  totalInPaisa: number;
  placedAt: string;
  table: { id: string; name: string } | null;
  items: OrderItem[];
};

const BOARD_COLUMNS: OrderStatus[] = ["pending", "confirmed", "preparing", "ready", "served"];

const ADVANCE_LABELS: Partial<Record<OrderStatus, string>> = {
  confirmed: "Confirm",
  preparing: "Start preparing",
  ready: "Mark ready",
  served: "Mark served",
  completed: "Complete",
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

export function OrdersBoard({
  slug,
  canEdit,
  canCancel,
}: {
  slug: string;
  canEdit: boolean;
  canCancel: boolean;
}) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyOrderId, setBusyOrderId] = useState<string | null>(null);
  // Re-render every 30s just to refresh "Xm ago" labels between polls.
  const [, forceTick] = useState(0);

  async function loadOrders() {
    try {
      const res = await apiGet<{ orders: Order[] }>(`${base(slug)}/orders`);
      setOrders(res.orders);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load orders.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Mount-time fetch plus polling — Phase 4's "realtime" is polling, not
    // push-based (no websocket/SSE infra yet); see PHASE_4_NOTES.md.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadOrders();
    const poll = setInterval(loadOrders, 5000);
    const tick = setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  async function updateStatus(order: Order, status: OrderStatus, reason?: string) {
    setBusyOrderId(order.id);
    try {
      const res = await apiPatch<{ order: Order }>(`${base(slug)}/orders/${order.id}/status`, {
        status,
        reason,
      });
      setOrders((prev) => prev.map((o) => (o.id === order.id ? { ...o, ...res.order } : o)));
      // A Kitchen Order Ticket is cut the moment an order is accepted into
      // the kitchen queue (see the status route's pending -> confirmed
      // handling) — pop the print page open right away so front-of-house
      // doesn't have to remember a separate "print ticket" step.
      if (order.status === "pending" && status === "confirmed") {
        openKotTicket(order.id);
      }
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not update order status.");
    } finally {
      setBusyOrderId(null);
    }
  }

  function handleCancel(order: Order) {
    const reason = window.prompt(`Cancel order #${order.orderNumber}? Add a reason (optional):`);
    if (reason === null) return; // user hit Cancel on the prompt itself
    updateStatus(order, "cancelled", reason || undefined);
  }

  if (loading) {
    return <p className="text-sm text-neutral-500">Loading orders…</p>;
  }

  const completedTodayCount = orders.filter((o) => o.status === "completed").length;
  const cancelledCount = orders.filter((o) => o.status === "cancelled").length;

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {BOARD_COLUMNS.map((status) => {
          const columnOrders = orders
            .filter((o) => o.status === status)
            .sort((a, b) => new Date(a.placedAt).getTime() - new Date(b.placedAt).getTime());
          return (
            <div key={status} className="rounded-2xl border border-neutral-200 bg-white p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-semibold text-neutral-900">
                  {ORDER_STATUS_LABELS[status]}
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
                  const forward = nextForwardStatus(order.status);
                  const canCancelThis = canTransition(order.status, "cancelled");
                  const busy = busyOrderId === order.id;
                  return (
                    <div
                      key={order.id}
                      className="rounded-xl border border-neutral-200 bg-neutral-50 p-3 text-xs"
                    >
                      <div className="mb-1 flex items-center justify-between">
                        <Link
                          href={`/dashboard/orders/${order.id}`}
                          className="font-semibold text-neutral-900 hover:text-orange-700 hover:underline"
                        >
                          #{order.orderNumber}
                        </Link>
                        <span className="text-neutral-400">{elapsedSince(order.placedAt)}</span>
                      </div>
                      <p className="text-neutral-500">
                        {order.table ? order.table.name : "Takeaway"}
                        {order.customerName ? ` · ${order.customerName}` : ""}
                      </p>
                      <ul className="mt-1 space-y-0.5 text-neutral-600">
                        {order.items.map((item) => (
                          <li key={item.id}>
                            {item.quantity}× {item.menuItemNameSnapshot}
                            {item.variantNameSnapshot ? ` (${item.variantNameSnapshot})` : ""}
                          </li>
                        ))}
                      </ul>
                      <p className="mt-1 font-semibold text-neutral-900">
                        {formatNPR(order.totalInPaisa)}
                      </p>

                      {(forward && canEdit) || (canCancelThis && canCancel) ? (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {forward && canEdit && (
                            <button
                              disabled={busy}
                              onClick={() => updateStatus(order, forward)}
                              className="rounded-full bg-orange-600 px-2.5 py-1 text-[11px] font-semibold text-white disabled:opacity-50"
                            >
                              {ADVANCE_LABELS[forward] ?? `Move to ${ORDER_STATUS_LABELS[forward]}`}
                            </button>
                          )}
                          {canCancelThis && canCancel && (
                            <button
                              disabled={busy}
                              onClick={() => handleCancel(order)}
                              className="rounded-full border border-neutral-300 px-2.5 py-1 text-[11px] font-medium text-neutral-500 hover:text-red-600 disabled:opacity-50"
                            >
                              Cancel
                            </button>
                          )}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <p className="text-xs text-neutral-400">
        {completedTodayCount} completed · {cancelledCount} cancelled (last 48 hours)
      </p>
    </div>
  );
}
