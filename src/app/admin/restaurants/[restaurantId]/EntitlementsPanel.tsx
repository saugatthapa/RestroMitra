"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPost, apiDelete, ApiError } from "@/lib/api-client";
import { FEATURE_DESCRIPTIONS } from "@/lib/feature-catalog";

type EntitlementSource = "override" | "plan" | "flag" | "none";

type EntitlementResult = {
  featureKey: string;
  granted: boolean;
  source: EntitlementSource;
  /** Only meaningful when source is "override" — the API omits it (undefined) for every other source, and sends null for a permanent override. Serialized as an ISO string over JSON. */
  expiresAt?: string | null;
};

/** "31 Dec 2026" — short enough for a table cell, unambiguous enough for a platform admin scanning several tenants' overrides. */
function formatExpiryDate(value: string) {
  return new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

const SOURCE_LABELS: Record<EntitlementSource, string> = {
  override: "Admin override",
  plan: "Plan",
  flag: "Feature flag",
  none: "Not entitled",
};

function sourceBadgeClass(source: EntitlementSource) {
  switch (source) {
    case "override":
      return "bg-purple-100 text-purple-700";
    case "plan":
      return "bg-emerald-50 text-emerald-700";
    case "flag":
      return "bg-blue-50 text-blue-700";
    default:
      return "bg-neutral-100 text-neutral-500";
  }
}

/**
 * Platform Control Center (Phase 5) — the "explain this tenant's access"
 * screen. Every known feature key, whether this restaurant currently has
 * it, and WHY (its plan, a global flag, or an explicit admin override) —
 * the exact question a platform admin needs answered when a customer asks
 * "why don't I see X" or "can you turn Y on for us early."
 */
export function EntitlementsPanel({ restaurantId }: { restaurantId: string }) {
  const [entitlements, setEntitlements] = useState<EntitlementResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [overrideKey, setOverrideKey] = useState<string | null>(null);
  const [overrideGranted, setOverrideGranted] = useState(true);
  const [overrideReason, setOverrideReason] = useState("");
  // "YYYY-MM-DD" from a <input type="date">, or "" for no expiry (the
  // common case — a permanent override). Kept as the raw picker string and
  // only converted to an ISO datetime at submit time.
  const [overrideExpiresAt, setOverrideExpiresAt] = useState("");
  const [overrideBusy, setOverrideBusy] = useState(false);
  const [overrideError, setOverrideError] = useState<string | null>(null);

  const [clearingKey, setClearingKey] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await apiGet<{ entitlements: EntitlementResult[] }>(
        `/api/admin/restaurants/${restaurantId}/entitlements`,
      );
      setEntitlements(res.entitlements);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load entitlements.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restaurantId]);

  async function handleSetOverride(e: React.FormEvent) {
    e.preventDefault();
    if (!overrideKey) return;
    setOverrideBusy(true);
    setOverrideError(null);
    try {
      await apiPost(`/api/admin/restaurants/${restaurantId}/entitlements`, {
        featureKey: overrideKey,
        granted: overrideGranted,
        reason: overrideReason,
        // Treat the picked calendar date as expiring at the END of that
        // day (not its start) — "unlock until Dec 31" reads as "still on
        // through Dec 31," and this is forgiving of the admin's own
        // timezone vs. the server's when the two don't match exactly.
        expiresAt: overrideExpiresAt ? `${overrideExpiresAt}T23:59:59.999Z` : "",
      });
      setOverrideKey(null);
      setOverrideReason("");
      setOverrideExpiresAt("");
      await load();
    } catch (err) {
      setOverrideError(err instanceof ApiError ? err.message : "Could not set that override.");
    } finally {
      setOverrideBusy(false);
    }
  }

  async function handleClear(featureKey: string) {
    setClearingKey(featureKey);
    try {
      await apiDelete(`/api/admin/restaurants/${restaurantId}/entitlements`, { featureKey });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not clear that override.");
    } finally {
      setClearingKey(null);
    }
  }

  return (
    <div className="mt-10">
      <h2 className="mb-3 text-sm font-semibold text-neutral-900">Entitlements</h2>
      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
      <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white">
        {loading ? (
          <p className="p-5 text-sm text-neutral-500">Loading…</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 text-left text-xs font-semibold tracking-wide text-neutral-500 uppercase">
              <tr>
                <th className="px-4 py-2.5">Feature</th>
                <th className="px-4 py-2.5">Access</th>
                <th className="px-4 py-2.5">Source</th>
                <th className="px-4 py-2.5">Expires</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {entitlements.map((e) => (
                <tr key={e.featureKey} className="border-t border-neutral-100">
                  <td className="px-4 py-2.5">
                    <p className="font-medium text-neutral-800">
                      {FEATURE_DESCRIPTIONS[e.featureKey as keyof typeof FEATURE_DESCRIPTIONS] ?? e.featureKey}
                    </p>
                    <p className="font-mono text-[11px] text-neutral-400">{e.featureKey}</p>
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        e.granted ? "bg-emerald-50 text-emerald-700" : "bg-neutral-100 text-neutral-500"
                      }`}
                    >
                      {e.granted ? "Granted" : "Denied"}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${sourceBadgeClass(e.source)}`}>
                      {SOURCE_LABELS[e.source]}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-neutral-500">
                    {e.source === "override" ? (e.expiresAt ? formatExpiryDate(e.expiresAt) : "No expiry") : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {e.source === "override" ? (
                      <button
                        type="button"
                        disabled={clearingKey === e.featureKey}
                        onClick={() => handleClear(e.featureKey)}
                        className="text-xs font-medium text-neutral-500 hover:text-neutral-800 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Clear override
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setOverrideKey(e.featureKey);
                          setOverrideGranted(!e.granted);
                          setOverrideReason("");
                          setOverrideExpiresAt("");
                          setOverrideError(null);
                        }}
                        className="text-xs font-medium text-orange-700 hover:text-orange-800"
                      >
                        Override
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {overrideKey && (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/40 p-4">
          <form onSubmit={handleSetOverride} className="w-full max-w-sm rounded-lg bg-white p-5 shadow-lg">
            <h3 className="text-sm font-semibold text-neutral-900">
              Override {FEATURE_DESCRIPTIONS[overrideKey as keyof typeof FEATURE_DESCRIPTIONS] ?? overrideKey}
            </h3>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => setOverrideGranted(true)}
                className={`flex-1 rounded-md border px-3 py-1.5 text-sm font-medium ${
                  overrideGranted
                    ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                    : "border-neutral-300 text-neutral-600"
                }`}
              >
                Force grant
              </button>
              <button
                type="button"
                onClick={() => setOverrideGranted(false)}
                className={`flex-1 rounded-md border px-3 py-1.5 text-sm font-medium ${
                  !overrideGranted ? "border-red-300 bg-red-50 text-red-700" : "border-neutral-300 text-neutral-600"
                }`}
              >
                Force deny
              </button>
            </div>
            <label className="mt-3 block text-sm">
              <span className="mb-1 block text-neutral-700">Reason (recorded in the audit log)</span>
              <input
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
                required
                minLength={3}
                autoFocus
                className="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none"
              />
            </label>
            <label className="mt-3 block text-sm">
              <span className="mb-1 block text-neutral-700">Expires (optional)</span>
              <input
                type="date"
                value={overrideExpiresAt}
                min={new Date().toISOString().slice(0, 10)}
                onChange={(e) => setOverrideExpiresAt(e.target.value)}
                className="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none"
              />
              <span className="mt-1 block text-xs text-neutral-400">
                Leave blank for no expiry — the override stays until manually cleared.
              </span>
            </label>
            {overrideError && <p className="mt-2 text-sm text-red-600">{overrideError}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOverrideKey(null)}
                disabled={overrideBusy}
                className="rounded-md border border-neutral-300 px-4 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={overrideBusy}
                className="rounded-md bg-orange-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {overrideBusy ? "Saving…" : "Save override"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
