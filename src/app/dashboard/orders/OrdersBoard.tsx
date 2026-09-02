"use client";

import { useCallback, useEffect, useState } from "react";
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
import { PAYMENT_STATUS_LABELS, type PaymentStatus } from "@/lib/payments";
import { OrderPaymentModal } from "./OrderPaymentModal";
import { useOnlineStatus } from "@/lib/use-online-status";
import {
  enqueueStatusUpdate,
  listQueuedStatusUpdates,
  removeQueuedStatusUpdate,
  syncQueuedStatusUpdates,
  isOfflineQueueSupported,
  type QueuedStatusUpdate,
} from "@/lib/offline-status-queue";

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
  paymentStatus: PaymentStatus;
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
  canExport,
}: {
  slug: string;
  canEdit: boolean;
  canCancel: boolean;
  canExport: boolean;
}) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyOrderId, setBusyOrderId] = useState<string | null>(null);
  // Re-render every 30s just to refresh "Xm ago" labels between polls.
  const [, forceTick] = useState(0);
  // The one place payment gets recorded from this board — opened either by
  // the "Record payment" quick action on any unpaid/partially-paid order, or
  // automatically when "Complete" is clicked on one (completeAfterPayment
  // true in that case). Replaces the old window.confirm()+navigate-away
  // flow: nothing about recording a payment or completing an unpaid order
  // requires leaving this page anymore.
  const [paymentModal, setPaymentModal] = useState<{
    orderId: string;
    orderNumber: string;
    completeAfterPayment: boolean;
  } | null>(null);

  // Phase 22 (offline mode) — status changes made while offline (or that
  // fail due to a network-level error even though the browser thought it
  // was online) are queued the same way POS already queues new orders (see
  // offline-status-queue.ts's module comment for why this is a separate
  // queue rather than sharing POS's). Payment-linked completion still
  // requires connectivity — see handleAdvance below.
  const [queuedUpdates, setQueuedUpdates] = useState<QueuedStatusUpdate[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [queuedMessage, setQueuedMessage] = useState<string | null>(null);

  const refreshQueue = useCallback(async () => {
    if (!isOfflineQueueSupported()) return;
    const rows = await listQueuedStatusUpdates(slug);
    setQueuedUpdates(rows);
  }, [slug]);

  const runSync = useCallback(async () => {
    if (!isOfflineQueueSupported() || syncing) return;
    setSyncing(true);
    try {
      const result = await syncQueuedStatusUpdates(slug, {
        applyStatus: async (update) => {
          await apiPatch(`${base(slug)}/orders/${update.orderId}/status`, {
            status: update.toStatus,
            reason: update.reason ?? undefined,
          });
          if (update.fromStatus === "pending" && update.toStatus === "confirmed") {
            openKotTicket(update.orderId);
          }
        },
        getCurrentStatus: async (orderId) => {
          try {
            const res = await apiGet<{ order: Order }>(`${base(slug)}/orders/${orderId}`);
            return res.order.status;
          } catch (err) {
            // A real response came back (e.g. 404, the order's gone) —
            // that's a definite answer, not a connectivity problem.
            if (err instanceof ApiError) return null;
            // fetch() itself threw — still offline. Propagate so the sync
            // loop knows to stop rather than mark this a real conflict.
            throw err;
          }
        },
      });
      if (result.synced > 0) loadOrders();
    } finally {
      await refreshQueue();
      setSyncing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, syncing, refreshQueue]);

  const isOnline = useOnlineStatus(runSync);

  async function discardQueuedUpdate(update: QueuedStatusUpdate) {
    const ok = window.confirm(
      `Discard this queued change to order #${update.orderNumber} (→ ${ORDER_STATUS_LABELS[update.toStatus]})? This cannot be undone.`,
    );
    if (!ok) return;
    await removeQueuedStatusUpdate(update.clientRequestId);
    await refreshQueue();
  }

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
    // Mount-time fetch, plus two refresh paths: DashboardShell's SSE
    // listener rebroadcasts order.created/order.status_changed as this
    // window event the instant they happen (see DashboardShell.tsx's own
    // comment for why that's DB-polling-backed SSE, not true push — still
    // real push to this component either way). The 5s poll stays as a
    // backstop underneath it — a dropped/reconnecting SSE connection, or a
    // change made through a path that doesn't publish an event, still
    // surfaces within 5s instead of silently going stale.
    loadOrders();
    refreshQueue();
    const poll = setInterval(loadOrders, 5000);
    const tick = setInterval(() => forceTick((n) => n + 1), 30_000);
    window.addEventListener("restromitra:orders-changed", loadOrders);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
      window.removeEventListener("restromitra:orders-changed", loadOrders);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  async function queueStatusChange(order: Order, status: OrderStatus, reason?: string) {
    if (!isOfflineQueueSupported()) {
      alert(
        "You're offline and this browser doesn't support saving changes for later — connect to the internet and try again.",
      );
      return;
    }
    await enqueueStatusUpdate({
      slug,
      orderId: order.id,
      orderNumber: order.orderNumber,
      fromStatus: order.status,
      toStatus: status,
      reason,
    });
    await refreshQueue();
    setQueuedMessage(
      `Order #${order.orderNumber} — will move to "${ORDER_STATUS_LABELS[status]}" once you're back online.`,
    );
  }

  async function updateStatus(order: Order, status: OrderStatus, reason?: string) {
    setBusyOrderId(order.id);
    setQueuedMessage(null);
    try {
      if (!isOnline) {
        await queueStatusChange(order, status, reason);
        return;
      }
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
      if (err instanceof ApiError) {
        // A real response came back (validation, permission, a genuine
        // 409 conflict) — that's not a connectivity problem, so it's a
        // real error to show, not something to silently queue.
        alert(err.message);
      } else {
        // fetch() itself threw — offline, DNS failure, timeout — even
        // though navigator.onLine said we were connected. Queue it exactly
        // like the explicit offline path above.
        await queueStatusChange(order, status, reason);
      }
    } finally {
      setBusyOrderId(null);
    }
  }

  function handleCancel(order: Order) {
    const reason = window.prompt(`Cancel order #${order.orderNumber}? Add a reason (optional):`);
    if (reason === null) return; // user hit Cancel on the prompt itself
    updateStatus(order, "cancelled", reason || undefined);
  }

  // ->completed is also the moment the status route books the order's full
  // total into Account Books as a "due" if it isn't marked paid yet (see
  // recordSalesLedgerEntry in the status route) — that used to happen
  // completely silently the instant someone clicked "Complete". Instead of a
  // window.confirm() that then navigated away to a separate order page, an
  // unpaid/partially-paid order opens the payment dialog right here, with
  // "record & complete" and "complete without paying" as two equally visible
  // buttons in it.
  function handleAdvance(order: Order, forward: OrderStatus) {
    if (forward === "completed" && order.paymentStatus !== "paid") {
      setPaymentModal({
        orderId: order.id,
        orderNumber: order.orderNumber,
        completeAfterPayment: true,
      });
      return;
    }
    updateStatus(order, forward);
  }

  // The quick action on any unpaid/partially-paid order card, regardless of
  // status/column — lets staff record a payment on the spot without waiting
  // for the order to reach "served".
  function handleRecordPayment(order: Order) {
    setPaymentModal({
      orderId: order.id,
      orderNumber: order.orderNumber,
      completeAfterPayment: false,
    });
  }

  if (loading) {
    return <p className="text-sm text-ink-muted">Loading orders…</p>;
  }

  const completedTodayCount = orders.filter((o) => o.status === "completed").length;
  const cancelledCount = orders.filter((o) => o.status === "cancelled").length;

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-400">{error}</p>}

      {canExport && (
        <div className="flex justify-end">
          <a href={`${base(slug)}/orders/export`} download className="btn-secondary text-xs">
            Export CSV
          </a>
        </div>
      )}

      {!isOnline && (
        <div className="flex items-center gap-2 rounded-lg bg-amber-500/15 px-3 py-2 text-xs font-medium text-amber-300">
          <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500" />
          You&apos;re offline — status changes will be saved on this device and applied
          automatically once you&apos;re back online.
        </div>
      )}
      {queuedUpdates.length > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/15 p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold text-amber-300">
              {queuedUpdates.length} change{queuedUpdates.length === 1 ? "" : "s"} waiting to sync
            </p>
            <button
              onClick={runSync}
              disabled={!isOnline || syncing}
              className="rounded-lg border border-amber-500/40 bg-surface-2 px-2.5 py-1 text-xs font-medium text-amber-300 disabled:opacity-50"
            >
              {syncing ? "Syncing…" : "Sync now"}
            </button>
          </div>
          <ul className="mt-2 space-y-1">
            {queuedUpdates.map((u) => (
              <li
                key={u.clientRequestId}
                className="flex items-center justify-between gap-2 text-xs text-amber-400"
              >
                <span>
                  #{u.orderNumber} → {ORDER_STATUS_LABELS[u.toStatus]}
                </span>
                <span className="flex items-center gap-2">
                  <span className={u.status === "error" ? "font-medium text-red-400" : ""}>
                    {u.status === "error" ? "Sync failed — will retry" : "Waiting"}
                  </span>
                  {u.status === "error" && (
                    <button
                      onClick={() => discardQueuedUpdate(u)}
                      className="rounded border border-red-500/40 px-1.5 py-0.5 font-medium text-red-400 hover:bg-red-500/15"
                    >
                      Discard
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {queuedMessage && (
        <p className="rounded-lg bg-green-500/15 px-3 py-2 text-xs font-medium text-green-400">
          {queuedMessage}
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {BOARD_COLUMNS.map((status) => {
          const columnOrders = orders
            .filter((o) => o.status === status)
            .sort((a, b) => new Date(a.placedAt).getTime() - new Date(b.placedAt).getTime());
          return (
            <div key={status} className="rounded-2xl border border-hairline bg-surface-2 p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-semibold text-ink">
                  {ORDER_STATUS_LABELS[status]}
                </p>
                <span className="rounded-full bg-surface-1 px-2 py-0.5 text-xs text-ink-muted">
                  {columnOrders.length}
                </span>
              </div>

              <div className="space-y-2">
                {columnOrders.length === 0 && (
                  <p className="text-xs text-ink-faint">Nothing here.</p>
                )}
                {columnOrders.map((order) => {
                  const forward = nextForwardStatus(order.status);
                  const canCancelThis = canTransition(order.status, "cancelled");
                  const busy = busyOrderId === order.id;
                  const isUnpaid = order.paymentStatus !== "paid";
                  return (
                    <div
                      key={order.id}
                      className="rounded-xl border border-hairline bg-surface-1 p-3 text-xs"
                    >
                      <div className="mb-1 flex items-center justify-between">
                        <Link
                          href={`/dashboard/orders/${order.id}`}
                          className="font-semibold text-ink hover:text-orange-300 hover:underline"
                        >
                          #{order.orderNumber}
                        </Link>
                        <span className="text-ink-faint">{elapsedSince(order.placedAt)}</span>
                      </div>
                      <p className="text-ink-muted">
                        {order.table ? order.table.name : "Takeaway"}
                        {order.customerName ? ` · ${order.customerName}` : ""}
                      </p>
                      <ul className="mt-1 space-y-0.5 text-ink-secondary">
                        {order.items.map((item) => (
                          <li key={item.id}>
                            {item.quantity}× {item.menuItemNameSnapshot}
                            {item.variantNameSnapshot ? ` (${item.variantNameSnapshot})` : ""}
                          </li>
                        ))}
                      </ul>
                      <div className="mt-1 flex items-center gap-2">
                        <p className="font-semibold text-ink">
                          {formatNPR(order.totalInPaisa)}
                        </p>
                        {isUnpaid && (
                          <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold text-amber-300">
                            {PAYMENT_STATUS_LABELS[order.paymentStatus]}
                          </span>
                        )}
                      </div>

                      {(forward && canEdit) || (canCancelThis && canCancel) || (isUnpaid && canEdit) ? (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {forward && canEdit && (
                            <button
                              disabled={busy}
                              onClick={() => handleAdvance(order, forward)}
                              className="rounded-full bg-orange-600 px-2.5 py-1 text-[11px] font-semibold text-white disabled:opacity-50"
                            >
                              {ADVANCE_LABELS[forward] ?? `Move to ${ORDER_STATUS_LABELS[forward]}`}
                            </button>
                          )}
                          {isUnpaid && canEdit && (
                            <button
                              disabled={busy}
                              onClick={() => handleRecordPayment(order)}
                              className="rounded-full bg-emerald-600 px-2.5 py-1 text-[11px] font-semibold text-white disabled:opacity-50"
                            >
                              Record payment
                            </button>
                          )}
                          {canCancelThis && canCancel && (
                            <button
                              disabled={busy}
                              onClick={() => handleCancel(order)}
                              className="rounded-full border border-hairline-strong px-2.5 py-1 text-[11px] font-medium text-ink-muted hover:text-red-400 disabled:opacity-50"
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

      <p className="text-xs text-ink-faint">
        {completedTodayCount} completed · {cancelledCount} cancelled (last 48 hours)
      </p>

      {paymentModal && (
        <OrderPaymentModal
          slug={slug}
          orderId={paymentModal.orderId}
          orderNumber={paymentModal.orderNumber}
          completeAfterPayment={paymentModal.completeAfterPayment}
          onClose={() => setPaymentModal(null)}
          onDone={() => {
            setPaymentModal(null);
            loadOrders();
          }}
        />
      )}
    </div>
  );
}
