"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiGet, ApiError } from "@/lib/api-client";

// Mirrors DashboardMetrics from src/lib/admin/dashboard-metrics-db.ts (a
// server-only module this client component can't import from directly —
// same "redefine the API's JSON shape locally" convention every other
// client panel on this page already uses, e.g. AdminOverview's own
// AdminRestaurant type).
type Metrics = {
  users: { total: number; active: number };
  branches: { total: number; active: number };
  orders: { today: number; thisMonth: number };
  revenue: { activeMonthlyInPaisa: number; pastDueMonthlyInPaisa: number };
  planDistribution: { planKey: string | null; planName: string; restaurantCount: number }[];
  featureUsage: {
    featureKey: string;
    name: string;
    defaultEnabled: boolean | null;
    viaPlanCount: number;
    overrideGrantedCount: number;
    overrideRevokedCount: number;
  }[];
};

type AuditLogRow = {
  id: string;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  createdAt: string;
  userFullName: string | null;
  restaurantId: string | null;
  restaurantName: string | null;
};

type DashboardStatsResponse = {
  metrics: Metrics;
  recentActivity: AuditLogRow[];
};

function formatPaisa(paisa: number) {
  return `Rs ${(paisa / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

function formatAction(action: string) {
  return action.replace(/[._]/g, " ");
}

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Gap-audit P1 fix (Finding 1) — the platform dashboard's commercial
 * metrics: total/active users, active branches, orders today/this month,
 * subscription revenue, plan distribution, feature-usage counts, and a
 * recent-activity feed. Reads the new /api/admin/dashboard-stats route
 * (real, efficient aggregate queries — see dashboard-metrics-db.ts), and
 * renders using this page's existing stat-tile/card visual language rather
 * than inventing new components.
 */
export function DashboardMetrics() {
  const [data, setData] = useState<DashboardStatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await apiGet<DashboardStatsResponse>("/api/admin/dashboard-stats");
        if (!cancelled) {
          setData(res);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Could not load dashboard metrics.");
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error && !data) return <p className="mb-6 text-sm text-red-600">{error}</p>;
  if (!data) return <p className="mb-6 text-sm text-neutral-400">Loading metrics…</p>;

  const { metrics, recentActivity } = data;

  return (
    <div className="mb-8">
      <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <MetricTile label="Total users" value={metrics.users.total.toLocaleString("en-IN")} />
        <MetricTile label="Active users" value={metrics.users.active.toLocaleString("en-IN")} />
        <MetricTile label="Active branches" value={`${metrics.branches.active} / ${metrics.branches.total}`} />
        <MetricTile label="Orders today" value={metrics.orders.today.toLocaleString("en-IN")} />
        <MetricTile label="Orders this month" value={metrics.orders.thisMonth.toLocaleString("en-IN")} />
        <MetricTile label="Active MRR" value={formatPaisa(metrics.revenue.activeMonthlyInPaisa)} />
      </div>
      {metrics.revenue.pastDueMonthlyInPaisa > 0 && (
        <p className="mb-4 text-xs text-amber-700">
          {formatPaisa(metrics.revenue.pastDueMonthlyInPaisa)}/mo billed but currently past due.
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="rounded-xl border border-neutral-200 bg-white p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Plan distribution
          </h3>
          <div className="space-y-1.5">
            {metrics.planDistribution.length === 0 && <p className="text-xs text-neutral-400">No restaurants yet.</p>}
            {metrics.planDistribution
              .slice()
              .sort((a, b) => b.restaurantCount - a.restaurantCount)
              .map((p) => (
                <div key={p.planKey ?? "none"} className="flex items-center justify-between text-sm">
                  <span className="text-neutral-700">{p.planName}</span>
                  <span className="font-medium tabular-nums text-neutral-900">{p.restaurantCount}</span>
                </div>
              ))}
          </div>
        </div>

        <div className="rounded-xl border border-neutral-200 bg-white p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Feature usage
          </h3>
          <div className="max-h-56 space-y-1.5 overflow-y-auto">
            {metrics.featureUsage.length === 0 && <p className="text-xs text-neutral-400">No features tracked yet.</p>}
            {metrics.featureUsage.map((f) => (
              <div key={f.featureKey} className="text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-neutral-700">{f.name}</span>
                  <span className="font-medium tabular-nums text-neutral-900">{f.viaPlanCount}</span>
                </div>
                {(f.overrideGrantedCount > 0 || f.overrideRevokedCount > 0) && (
                  <p className="text-[11px] text-neutral-400">
                    {f.overrideGrantedCount > 0 && `+${f.overrideGrantedCount} via override`}
                    {f.overrideGrantedCount > 0 && f.overrideRevokedCount > 0 && " · "}
                    {f.overrideRevokedCount > 0 && `−${f.overrideRevokedCount} revoked`}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-neutral-200 bg-white p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Recent activity
          </h3>
          <div className="max-h-56 space-y-2 overflow-y-auto">
            {recentActivity.length === 0 && <p className="text-xs text-neutral-400">No activity yet.</p>}
            {recentActivity.map((event) => (
              <div key={event.id} className="text-xs">
                <p className="text-neutral-700">
                  {formatAction(event.action)}
                  {event.restaurantName && (
                    <>
                      {" · "}
                      <Link href={`/admin/restaurants/${event.restaurantId}`} className="text-neutral-500 hover:underline">
                        {event.restaurantName}
                      </Link>
                    </>
                  )}
                </p>
                <p className="text-neutral-400">
                  {event.userFullName ?? "System"} · {formatDateTime(event.createdAt)}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-3">
      <p className="text-xs font-medium text-neutral-500">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums text-neutral-900">{value}</p>
    </div>
  );
}
