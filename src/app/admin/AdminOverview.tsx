"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { apiGet, ApiError } from "@/lib/api-client";
import { SUBSCRIPTION_STATUSES, SUBSCRIPTION_STATUS_LABELS, type SubscriptionStatus } from "@/lib/subscription";
import { getPlanByKey } from "@/lib/plans";

type AdminRestaurant = {
  id: string;
  slug: string;
  name: string;
  type: string;
  subscriptionStatus: SubscriptionStatus;
  trialEndsAt: string | null;
  planKey: string | null;
  isActive: boolean;
  createdAt: string;
  owner: { fullName: string; phone: string } | null;
};

function statusBadgeClass(status: SubscriptionStatus) {
  switch (status) {
    case "active":
      return "bg-emerald-50 text-emerald-700";
    case "trialing":
      return "bg-orange-50 text-orange-700";
    case "past_due":
      return "bg-amber-50 text-amber-700";
    default:
      return "bg-red-50 text-red-700";
  }
}

export function AdminOverview() {
  const [restaurants, setRestaurants] = useState<AdminRestaurant[]>([]);
  const [statusFilter, setStatusFilter] = useState<SubscriptionStatus | "">("");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (statusFilter) params.set("status", statusFilter);
        if (q) params.set("q", q);
        const qs = params.toString();
        const res = await apiGet<{ restaurants: AdminRestaurant[] }>(
          `/api/admin/restaurants${qs ? `?${qs}` : ""}`,
        );
        if (!cancelled) {
          setRestaurants(res.restaurants);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Could not load restaurants.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [statusFilter, q]);

  const stats = useMemo(() => {
    const byStatus: Record<string, number> = {};
    for (const r of restaurants) byStatus[r.subscriptionStatus] = (byStatus[r.subscriptionStatus] ?? 0) + 1;
    return byStatus;
  }, [restaurants]);

  return (
    <div>
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <StatTile label="Total" value={restaurants.length} />
        <StatTile label="Trialing" value={stats.trialing ?? 0} />
        <StatTile label="Active" value={stats.active ?? 0} />
        <StatTile label="Past due" value={stats.past_due ?? 0} />
        <StatTile label="Expired / cancelled" value={(stats.expired ?? 0) + (stats.cancelled ?? 0)} />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by name or slug…"
          className="input max-w-xs"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as SubscriptionStatus | "")}
          className="input w-auto"
        >
          <option value="">All statuses</option>
          {SUBSCRIPTION_STATUSES.map((s) => (
            <option key={s} value={s}>
              {SUBSCRIPTION_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </div>

      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

      <div className={`overflow-hidden rounded-xl border border-neutral-200 bg-white ${loading ? "opacity-60" : ""}`}>
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs font-semibold tracking-wide text-neutral-500 uppercase">
            <tr>
              <th className="px-4 py-3">Restaurant</th>
              <th className="px-4 py-3">Owner</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Plan</th>
              <th className="px-4 py-3">Trial ends</th>
            </tr>
          </thead>
          <tbody>
            {restaurants.map((r) => (
              <tr key={r.id} className="border-t border-neutral-100 hover:bg-neutral-50">
                <td className="px-4 py-3">
                  <Link href={`/admin/restaurants/${r.id}`} className="font-medium text-neutral-900 hover:underline">
                    {r.name}
                  </Link>
                  <p className="text-xs text-neutral-400">{r.slug}</p>
                </td>
                <td className="px-4 py-3 text-neutral-600">
                  {r.owner ? (
                    <>
                      {r.owner.fullName}
                      <p className="text-xs text-neutral-400">{r.owner.phone}</p>
                    </>
                  ) : (
                    <span className="text-neutral-400">—</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusBadgeClass(r.subscriptionStatus)}`}>
                    {SUBSCRIPTION_STATUS_LABELS[r.subscriptionStatus]}
                  </span>
                </td>
                <td className="px-4 py-3 text-neutral-600">{getPlanByKey(r.planKey)?.name ?? "—"}</td>
                <td className="px-4 py-3 text-neutral-500">
                  {r.trialEndsAt
                    ? new Date(r.trialEndsAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
                    : "—"}
                </td>
              </tr>
            ))}
            {!loading && restaurants.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-neutral-400">
                  No restaurants match this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-3">
      <p className="text-xs font-medium text-neutral-500">{label}</p>
      <p className="mt-1 text-lg font-semibold text-neutral-900">{value}</p>
    </div>
  );
}
