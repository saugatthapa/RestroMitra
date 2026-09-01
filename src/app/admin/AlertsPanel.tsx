"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiGet, ApiError } from "@/lib/api-client";

type AiFailure = {
  id: string;
  restaurantId: string;
  restaurantName: string;
  provider: string;
  model: string;
  errorMessage: string | null;
  latencyMs: number | null;
  createdAt: string;
};

type SystemErrorEntry = { message: string; createdAt: string };

type AlertsResponse = { aiFailures: AiFailure[]; systemErrors: SystemErrorEntry[] };

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Gap-audit P1 fix (Finding 3) — proactive platform alerting: recent AI
 * provider failures and recent unhandled system errors, an in-app "recent
 * alerts" list (deliberately no email/SMS/push — out of this fix's scope,
 * see the gap-audit finding's own "pragmatic" guidance). Reads
 * /api/admin/alerts (MANAGE_SYSTEM-gated, same audience as /admin/system's
 * operational-health page).
 */
export function AlertsPanel() {
  const [data, setData] = useState<AlertsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await apiGet<AlertsResponse>("/api/admin/alerts");
        if (!cancelled) {
          setData(res);
          setError(null);
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && /permission/i.test(err.message)) {
          setForbidden(true);
          return;
        }
        setError(err instanceof ApiError ? err.message : "Could not load alerts.");
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (forbidden) return null;
  if (error) return <p className="mb-6 text-sm text-red-600">{error}</p>;
  if (!data) return null;

  const totalAlerts = data.aiFailures.length + data.systemErrors.length;
  if (totalAlerts === 0) return null;

  return (
    <div className="mb-8 rounded-xl border border-amber-200 bg-amber-50 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-amber-900">Recent alerts</h2>
        <span className="rounded-full bg-amber-200 px-2.5 py-0.5 text-xs font-semibold text-amber-900">
          {totalAlerts}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-amber-800">
            AI provider failures
          </h3>
          {data.aiFailures.length === 0 ? (
            <p className="text-xs text-amber-700">No recent AI provider failures.</p>
          ) : (
            <div className="max-h-56 space-y-2 overflow-y-auto">
              {data.aiFailures.map((f) => (
                <div key={f.id} className="rounded-lg bg-white/70 px-3 py-2 text-xs">
                  <p className="font-medium text-neutral-800">
                    {f.provider} ({f.model}){" "}
                    <Link href={`/admin/restaurants/${f.restaurantId}`} className="text-neutral-500 hover:underline">
                      · {f.restaurantName}
                    </Link>
                  </p>
                  <p className="text-neutral-600">{f.errorMessage ?? "No error message recorded."}</p>
                  <p className="text-neutral-400">{formatDateTime(f.createdAt)}</p>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-amber-800">
            System errors
          </h3>
          {data.systemErrors.length === 0 ? (
            <p className="text-xs text-amber-700">No recent unhandled system errors.</p>
          ) : (
            <div className="max-h-56 space-y-2 overflow-y-auto">
              {data.systemErrors.map((e, i) => (
                <div key={i} className="rounded-lg bg-white/70 px-3 py-2 text-xs">
                  <p className="text-neutral-700">{e.message}</p>
                  <p className="text-neutral-400">{formatDateTime(e.createdAt)}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
