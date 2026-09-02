"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiGet, ApiError } from "@/lib/api-client";
import { HEALTH_BAND_LABELS, type HealthBand } from "@/lib/support/health-score";

type AtRiskTenant = {
  restaurantId: string;
  restaurantName: string;
  restaurantSlug: string;
  healthScore: { score: number; band: HealthBand; reasons: { label: string; delta: number }[] };
};

const BAND_CLASSES: Record<HealthBand, string> = {
  healthy: "bg-emerald-50 text-emerald-700 border-emerald-200",
  watch: "bg-amber-50 text-amber-700 border-amber-200",
  at_risk: "bg-red-50 text-red-700 border-red-200",
};

/**
 * Gap-audit P1 fix (Finding 3) — proactive, platform-wide "these N tenants
 * are at risk" surfaced right on the dashboard, instead of a health score
 * only visible one restaurant at a time on its own detail page. Reads
 * /api/admin/at-risk-tenants (MANAGE_SUPPORT-gated, same audience as the
 * restaurant detail page's own health score panel) — a caller without
 * that permission simply doesn't see this section (matches this page's
 * existing "show the API's error text" convention for a gated panel, see
 * SystemHealthPanel).
 */
export function AtRiskTenants() {
  const [tenants, setTenants] = useState<AtRiskTenant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await apiGet<{ tenants: AtRiskTenant[] }>("/api/admin/at-risk-tenants");
        if (!cancelled) {
          setTenants(res.tenants);
          setError(null);
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && /permission/i.test(err.message)) {
          // Not a support role — this section just isn't for this viewer,
          // same as SupportPanel's own null-when-ungated behavior on the
          // restaurant detail page.
          setForbidden(true);
          return;
        }
        setError(err instanceof ApiError ? err.message : "Could not load at-risk tenants.");
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (forbidden) return null;
  if (error) return <p className="mb-6 text-sm text-red-600">{error}</p>;
  if (!tenants) return null;

  return (
    <div className="mb-8 rounded-xl border border-red-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-neutral-900">At-risk tenants</h2>
        <span className="rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-semibold text-red-800">
          {tenants.length}
        </span>
      </div>
      {tenants.length === 0 ? (
        <p className="text-sm text-neutral-400">No tenants currently at risk.</p>
      ) : (
        <div className="space-y-2">
          {tenants.map((t) => (
            <Link
              key={t.restaurantId}
              href={`/admin/restaurants/${t.restaurantId}`}
              className="flex items-center justify-between rounded-lg border border-neutral-100 px-3 py-2 text-sm hover:bg-neutral-50"
            >
              <div>
                <p className="font-medium text-neutral-900">{t.restaurantName}</p>
                <p className="text-xs text-neutral-400">
                  {t.healthScore.reasons.map((r) => r.label).join(" · ") || "No specific reasons"}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold tabular-nums text-neutral-900">{t.healthScore.score}</span>
                <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${BAND_CLASSES[t.healthScore.band]}`}>
                  {HEALTH_BAND_LABELS[t.healthScore.band]}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
