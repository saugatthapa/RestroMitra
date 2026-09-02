"use client";

import { useEffect, useState } from "react";
import { apiGet, ApiError } from "@/lib/api-client";
import { buildAuditLogParams } from "@/lib/audit-log-query";
import { formatAuditLogEntry, formatAuditLogModifiers } from "@/lib/audit-log-format";

type AuditLogEntry = {
  id: string;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  ipAddress: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  userId: string | null;
  userFullName: string | null;
  restaurantId: string | null;
  restaurantName: string | null;
};

const PAGE_SIZE = 50;

function formatWhen(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** "payment.refunded" -> "Payment Refunded" — readable without a hand-maintained label map for every action string this app's many call sites might record. */
function formatAction(action: string) {
  return action
    .split(/[._]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Platform Control Center (Phase 6) — the platform-wide audit log viewer.
 * Same shape as the tenant-side AuditLogBoard (dashboard/audit-log), but
 * spans every restaurant and adds a Tenant column + a restaurant filter,
 * since a platform admin's audit trail question is rarely scoped to just
 * one tenant.
 */
export function AuditLogBoard() {
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [actionFilter, setActionFilter] = useState("");
  const [restaurantIdFilter, setRestaurantIdFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const params = buildAuditLogParams({ action: actionFilter }, { limit: PAGE_SIZE, offset });
    if (restaurantIdFilter.trim()) params.set("restaurantId", restaurantIdFilter.trim());

    apiGet<{ logs: AuditLogEntry[]; hasMore: boolean }>(`/api/admin/audit-log?${params}`)
      .then((data) => {
        if (cancelled) return;
        setLogs(data.logs);
        setHasMore(data.hasMore);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "Failed to load the platform audit log.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [offset, actionFilter, restaurantIdFilter]);

  return (
    <div className="rounded-lg border border-hairline bg-surface-2">
      <div className="flex flex-wrap items-center gap-3 border-b border-hairline p-4">
        <input
          type="text"
          value={actionFilter}
          onChange={(e) => {
            setOffset(0);
            setActionFilter(e.target.value);
          }}
          placeholder="Filter by action (e.g. plan, feature_flag, platform_role)"
          className="w-full max-w-xs rounded-md border border-hairline-strong px-3 py-1.5 text-sm text-ink placeholder:text-ink-faint focus:border-hairline-strong focus:outline-none"
        />
        <select
          value={restaurantIdFilter}
          onChange={(e) => {
            setOffset(0);
            setRestaurantIdFilter(e.target.value);
          }}
          className="rounded-md border border-hairline-strong px-3 py-1.5 text-sm text-ink focus:border-hairline-strong focus:outline-none"
        >
          <option value="">Every tenant + platform</option>
          <option value="platform">Platform-only (no tenant)</option>
        </select>
      </div>

      {error && <p className="p-4 text-sm text-red-400">{error}</p>}

      {!error && loading && logs.length === 0 && <p className="p-4 text-sm text-ink-muted">Loading…</p>}

      {!error && !loading && logs.length === 0 && (
        <p className="p-4 text-sm text-ink-muted">No activity recorded yet for this filter.</p>
      )}

      {logs.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-hairline text-xs uppercase tracking-wide text-ink-muted">
                <th className="px-4 py-2 font-medium">When</th>
                <th className="px-4 py-2 font-medium">Who</th>
                <th className="px-4 py-2 font-medium">Tenant</th>
                <th className="px-4 py-2 font-medium">Action</th>
                <th className="px-4 py-2 font-medium">Resource</th>
                <th className="px-4 py-2 font-medium">IP</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => {
                const isExpanded = expandedId === log.id;
                const hasMetadata = log.metadata && Object.keys(log.metadata).length > 0;
                // RC audit P1 fix (impersonation events rendering as raw
                // JSON) — same formatter the tenant-side board uses (see
                // its own comment); here every row already carries its own
                // restaurantName, so the sentence just uses that instead of
                // a fixed "this restaurant" label.
                const readableSentence = formatAuditLogEntry({
                  action: log.action,
                  metadata: log.metadata,
                  userFullName: log.userFullName,
                });
                const modifiers = formatAuditLogModifiers(log.metadata);
                return (
                  <tr
                    key={log.id}
                    className="cursor-pointer border-b border-hairline/60 align-top hover:bg-surface-1"
                    onClick={() => hasMetadata && setExpandedId(isExpanded ? null : log.id)}
                  >
                    <td className="whitespace-nowrap px-4 py-2 text-ink-muted">{formatWhen(log.createdAt)}</td>
                    <td className="px-4 py-2 text-ink-secondary">
                      {log.userFullName ?? (log.userId ? "Deactivated user" : "System")}
                    </td>
                    <td className="px-4 py-2 text-ink-muted">
                      {log.restaurantId ? (
                        <a
                          href={`/admin/restaurants/${log.restaurantId}`}
                          className="text-orange-400 hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {log.restaurantName ?? log.restaurantId.slice(0, 8)}
                        </a>
                      ) : (
                        <span className="text-ink-faint">Platform</span>
                      )}
                    </td>
                    <td className="px-4 py-2 font-medium text-ink">
                      {formatAction(log.action)}
                      {modifiers && (
                        <span className="ml-1.5 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-normal text-amber-400">
                          {modifiers}
                        </span>
                      )}
                      {hasMetadata && !readableSentence && (
                        <span className="ml-1.5 text-xs text-ink-faint">{isExpanded ? "▲" : "▼"}</span>
                      )}
                      {readableSentence && (
                        <p className="mt-1 max-w-md whitespace-normal font-normal text-ink-secondary">{readableSentence}</p>
                      )}
                      {isExpanded && hasMetadata && !readableSentence && (
                        <pre className="mt-1 max-w-md overflow-x-auto rounded bg-surface-1 p-2 text-xs text-ink-secondary">
                          {JSON.stringify(log.metadata, null, 2)}
                        </pre>
                      )}
                    </td>
                    <td className="px-4 py-2 text-ink-muted">
                      {log.resourceType ? `${log.resourceType}${log.resourceId ? ` · ${log.resourceId.slice(0, 8)}` : ""}` : "—"}
                    </td>
                    <td className="px-4 py-2 text-ink-muted">{log.ipAddress ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {(offset > 0 || hasMore) && (
        <div className="flex items-center justify-between border-t border-hairline p-4 text-sm">
          <button
            type="button"
            disabled={offset === 0 || loading}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            className="rounded-md border border-hairline-strong px-3 py-1.5 text-ink-secondary disabled:cursor-not-allowed disabled:opacity-40"
          >
            Newer
          </button>
          <button
            type="button"
            disabled={!hasMore || loading}
            onClick={() => setOffset(offset + PAGE_SIZE)}
            className="rounded-md border border-hairline-strong px-3 py-1.5 text-ink-secondary disabled:cursor-not-allowed disabled:opacity-40"
          >
            Older
          </button>
        </div>
      )}
    </div>
  );
}
