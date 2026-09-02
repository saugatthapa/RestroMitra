"use client";

import { useEffect, useState } from "react";
import { apiGet, ApiError } from "@/lib/api-client";

/**
 * Gap-audit P1 fix (Finding 2) — the restaurant detail page was missing
 * branches, recent orders, and restaurant-scoped audit events, even though
 * all three already exist elsewhere in the system. Three small,
 * independently-loading panels (each its own fetch, so a slow one never
 * blocks the others) rather than piling more fields onto the existing
 * detail route's already-large response.
 */

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function formatPaisa(paisa: number) {
  return `Rs ${(paisa / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

type Branch = {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  phone: string | null;
  isMain: boolean;
  isActive: boolean;
  createdAt: string;
};

export function BranchesPanel({ restaurantId }: { restaurantId: string }) {
  const [branches, setBranches] = useState<Branch[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiGet<{ branches: Branch[] }>(`/api/admin/restaurants/${restaurantId}/branches`)
      .then((res) => !cancelled && setBranches(res.branches))
      .catch((err) => !cancelled && setError(err instanceof ApiError ? err.message : "Could not load branches."));
    return () => {
      cancelled = true;
    };
  }, [restaurantId]);

  return (
    <div className="rounded-xl border border-hairline bg-surface-2 p-4">
      <h2 className="mb-3 text-sm font-semibold text-ink">Branches</h2>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {!branches && !error && <p className="text-sm text-ink-faint">Loading…</p>}
      {branches && branches.length === 0 && <p className="text-sm text-ink-faint">No branches yet.</p>}
      {branches && branches.length > 0 && (
        <div className="space-y-2">
          {branches.map((b) => (
            <div key={b.id} className="rounded-lg border border-hairline/60 px-3 py-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-medium text-ink">
                  {b.name}
                  {b.isMain && (
                    <span className="ml-2 rounded-full bg-surface-1 px-2 py-0.5 text-[10px] font-medium text-ink-secondary">
                      Main
                    </span>
                  )}
                </span>
                {!b.isActive && (
                  <span className="rounded-full bg-red-500/20 px-2 py-0.5 text-[10px] font-medium text-red-400">
                    Inactive
                  </span>
                )}
              </div>
              <p className="text-xs text-ink-muted">
                {[b.city, b.address].filter(Boolean).join(", ") || "—"}
                {b.phone && ` · ${b.phone}`}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type OrderRow = {
  id: string;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  source: string;
  totalInPaisa: number;
  branchName: string;
  createdAt: string;
};

export function RecentOrdersPanel({ restaurantId }: { restaurantId: string }) {
  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiGet<{ orders: OrderRow[] }>(`/api/admin/restaurants/${restaurantId}/orders`)
      .then((res) => !cancelled && setOrders(res.orders))
      .catch((err) => !cancelled && setError(err instanceof ApiError ? err.message : "Could not load orders."));
    return () => {
      cancelled = true;
    };
  }, [restaurantId]);

  return (
    <div className="rounded-xl border border-hairline bg-surface-2 p-4">
      <h2 className="mb-3 text-sm font-semibold text-ink">Recent orders</h2>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {!orders && !error && <p className="text-sm text-ink-faint">Loading…</p>}
      {orders && orders.length === 0 && <p className="text-sm text-ink-faint">No orders yet.</p>}
      {orders && orders.length > 0 && (
        <div className="max-h-80 space-y-1.5 overflow-y-auto">
          {orders.map((o) => (
            <div key={o.id} className="flex items-center justify-between rounded-lg border border-hairline/60 px-3 py-2 text-sm">
              <div>
                <p className="font-medium text-ink">
                  {o.orderNumber} <span className="text-xs font-normal text-ink-faint">· {o.branchName}</span>
                </p>
                <p className="text-xs text-ink-muted">
                  {o.status.replace(/_/g, " ")} · {o.paymentStatus.replace(/_/g, " ")} · {formatDateTime(o.createdAt)}
                </p>
              </div>
              <span className="font-medium tabular-nums text-ink">{formatPaisa(o.totalInPaisa)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type AuditLogRow = {
  id: string;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  createdAt: string;
  userFullName: string | null;
};

export function RestaurantAuditLogPanel({ restaurantId }: { restaurantId: string }) {
  const [logs, setLogs] = useState<AuditLogRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiGet<{ logs: AuditLogRow[] }>(`/api/admin/audit-log?restaurantId=${restaurantId}&limit=20`)
      .then((res) => !cancelled && setLogs(res.logs))
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && /permission/i.test(err.message)) {
          setForbidden(true);
          return;
        }
        setError(err instanceof ApiError ? err.message : "Could not load activity.");
      });
    return () => {
      cancelled = true;
    };
  }, [restaurantId]);

  if (forbidden) return null;

  return (
    <div className="rounded-xl border border-hairline bg-surface-2 p-4">
      <h2 className="mb-3 text-sm font-semibold text-ink">Restaurant activity</h2>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {!logs && !error && <p className="text-sm text-ink-faint">Loading…</p>}
      {logs && logs.length === 0 && <p className="text-sm text-ink-faint">No activity recorded yet.</p>}
      {logs && logs.length > 0 && (
        <div className="max-h-80 space-y-2 overflow-y-auto">
          {logs.map((l) => (
            <div key={l.id} className="text-xs">
              <p className="text-ink-secondary">{l.action.replace(/[._]/g, " ")}</p>
              <p className="text-ink-faint">
                {l.userFullName ?? "System"} · {formatDate(l.createdAt)}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
