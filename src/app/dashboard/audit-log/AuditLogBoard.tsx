"use client";

import { useEffect, useState } from "react";
import { apiGet, ApiError } from "@/lib/api-client";

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
};

const PAGE_SIZE = 50;

function base(slug: string) {
  return `/api/restaurants/${slug}`;
}

function formatWhen(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** "payment.refunded" -> "Payment Refunded" — readable without a hand-maintained label map for every action string this app's 55+ call sites might record. */
function formatAction(action: string) {
  return action
    .split(/[._]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function AuditLogBoard({ slug }: { slug: string }) {
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [actionFilter, setActionFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    if (actionFilter.trim()) params.set("action", actionFilter.trim());

    apiGet<{ logs: AuditLogEntry[]; hasMore: boolean }>(`${base(slug)}/audit-log?${params}`)
      .then((data) => {
        if (cancelled) return;
        setLogs(data.logs);
        setHasMore(data.hasMore);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "Failed to load the activity log.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [slug, offset, actionFilter]);

  return (
    <div className="rounded-lg border border-neutral-200 bg-white">
      <div className="flex flex-wrap items-center gap-3 border-b border-neutral-200 p-4">
        <input
          type="text"
          value={actionFilter}
          onChange={(e) => {
            setOffset(0);
            setActionFilter(e.target.value);
          }}
          placeholder="Filter by action (e.g. payment, staff, order)"
          className="w-full max-w-xs rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none"
        />
      </div>

      {error && (
        <p className="p-4 text-sm text-red-600">{error}</p>
      )}

      {!error && loading && logs.length === 0 && (
        <p className="p-4 text-sm text-neutral-500">Loading…</p>
      )}

      {!error && !loading && logs.length === 0 && (
        <p className="p-4 text-sm text-neutral-500">No activity recorded yet for this filter.</p>
      )}

      {logs.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
                <th className="px-4 py-2 font-medium">When</th>
                <th className="px-4 py-2 font-medium">Who</th>
                <th className="px-4 py-2 font-medium">Action</th>
                <th className="px-4 py-2 font-medium">Resource</th>
                <th className="px-4 py-2 font-medium">IP</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => {
                const isExpanded = expandedId === log.id;
                const hasMetadata = log.metadata && Object.keys(log.metadata).length > 0;
                return (
                  <tr
                    key={log.id}
                    className="cursor-pointer border-b border-neutral-100 align-top hover:bg-neutral-50"
                    onClick={() => hasMetadata && setExpandedId(isExpanded ? null : log.id)}
                  >
                    <td className="whitespace-nowrap px-4 py-2 text-neutral-500">
                      {formatWhen(log.createdAt)}
                    </td>
                    <td className="px-4 py-2 text-neutral-700">
                      {log.userFullName ?? (log.userId ? "Deactivated user" : "System")}
                    </td>
                    <td className="px-4 py-2 font-medium text-neutral-900">
                      {formatAction(log.action)}
                      {hasMetadata && (
                        <span className="ml-1.5 text-xs text-neutral-400">
                          {isExpanded ? "▲" : "▼"}
                        </span>
                      )}
                      {isExpanded && hasMetadata && (
                        <pre className="mt-1 max-w-md overflow-x-auto rounded bg-neutral-50 p-2 text-xs text-neutral-600">
                          {JSON.stringify(log.metadata, null, 2)}
                        </pre>
                      )}
                    </td>
                    <td className="px-4 py-2 text-neutral-500">
                      {log.resourceType ? `${log.resourceType}${log.resourceId ? ` · ${log.resourceId.slice(0, 8)}` : ""}` : "—"}
                    </td>
                    <td className="px-4 py-2 text-neutral-500">{log.ipAddress ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {(offset > 0 || hasMore) && (
        <div className="flex items-center justify-between border-t border-neutral-200 p-4 text-sm">
          <button
            type="button"
            disabled={offset === 0 || loading}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-neutral-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Newer
          </button>
          <button
            type="button"
            disabled={!hasMore || loading}
            onClick={() => setOffset(offset + PAGE_SIZE)}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-neutral-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Older
          </button>
        </div>
      )}
    </div>
  );
}
