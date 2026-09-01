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
  branchId: string | null;
  branchName: string | null;
};

type StaffOption = { userId: string; fullName: string };
type BranchOption = { id: string; name: string };

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

/**
 * RC audit P1 fix (gap audit finding) — the tenant-side resourceType filter
 * dropdown. Curated to the resource kinds an actual restaurant-facing audit
 * event can carry (excludes the platform-admin-only kinds like
 * feature_flag/plan/entitlement_override, which never appear on a
 * restaurant-scoped log — see listAuditLogs' restaurantId scoping) rather
 * than deriving it from live data, so the dropdown is stable and doesn't
 * require an extra "distinct resource types" query on every page load.
 */
const RESOURCE_TYPES = [
  "order",
  "payment",
  "payment_gateway_transaction",
  "table",
  "reservation",
  "purchase",
  "supplier",
  "stock_count",
  "stock_transfer",
  "inventory_item",
  "menu_item",
  "menu_variant",
  "menu_addon",
  "menu_combo",
  "category",
  "customer",
  "coupon",
  "expense",
  "expense_category",
  "ledger_entry",
  "daily_close",
  "register_shift",
  "register_cash_movement",
  "payroll_payment",
  "staff_salary_config",
  "user_role",
  "attendance_record",
  "leave_request",
  "holiday",
  "scheduled_shift",
  "service_call",
  "branch",
  "restaurant_website",
  "restaurant",
  "impersonation_session",
] as const;

function formatResourceType(resourceType: string) {
  return resourceType
    .split(/[._]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

const inputClass =
  "rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none";

export function AuditLogBoard({ slug }: { slug: string }) {
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [actionFilter, setActionFilter] = useState("");
  const [resourceTypeFilter, setResourceTypeFilter] = useState("");
  const [userIdFilter, setUserIdFilter] = useState("");
  const [branchIdFilter, setBranchIdFilter] = useState("");
  const [fromFilter, setFromFilter] = useState("");
  const [toFilter, setToFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [branches, setBranches] = useState<BranchOption[]>([]);

  // Staff/branch lists for the filter dropdowns — fetched once, not
  // refetched on every filter change. Both routes are already gated
  // MANAGE_STAFF-or-looser, so a viewer who can even load this page (itself
  // gated MANAGE_STAFF, see page.tsx) is always allowed to read them.
  useEffect(() => {
    let cancelled = false;
    apiGet<{ staff: { userId: string; fullName: string }[] }>(`${base(slug)}/staff`)
      .then((data) => {
        if (cancelled) return;
        setStaff(data.staff.map((s) => ({ userId: s.userId, fullName: s.fullName })));
      })
      .catch(() => {
        // Non-fatal — the user filter dropdown just stays empty; the log itself still loads.
      });
    apiGet<{ branches: { id: string; name: string }[] }>(`${base(slug)}/branches`)
      .then((data) => {
        if (cancelled) return;
        setBranches(data.branches.map((b) => ({ id: b.id, name: b.name })));
      })
      .catch(() => {
        // Non-fatal, same rationale as staff above.
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const params = buildAuditLogParams(
      {
        action: actionFilter,
        resourceType: resourceTypeFilter,
        userId: userIdFilter,
        branchId: branchIdFilter,
        from: fromFilter,
        to: toFilter,
      },
      { limit: PAGE_SIZE, offset },
    );

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
  }, [slug, offset, actionFilter, resourceTypeFilter, userIdFilter, branchIdFilter, fromFilter, toFilter]);

  /** Every filter setter resets to page 1 — a stale offset against a narrower result set would otherwise show "no results" instead of just... the first page of the new filter. */
  function setFilter<T>(setter: (value: T) => void) {
    return (value: T) => {
      setOffset(0);
      setter(value);
    };
  }

  const hasActiveFilters =
    actionFilter || resourceTypeFilter || userIdFilter || branchIdFilter || fromFilter || toFilter;

  function clearFilters() {
    setOffset(0);
    setActionFilter("");
    setResourceTypeFilter("");
    setUserIdFilter("");
    setBranchIdFilter("");
    setFromFilter("");
    setToFilter("");
  }

  return (
    <div className="rounded-lg border border-neutral-200 bg-white">
      <div className="flex flex-wrap items-end gap-3 border-b border-neutral-200 p-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-neutral-600">Action</label>
          <input
            type="text"
            value={actionFilter}
            onChange={(e) => setFilter(setActionFilter)(e.target.value)}
            placeholder="e.g. payment, staff, order"
            className={`w-full max-w-xs ${inputClass}`}
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-neutral-600">Resource</label>
          <select
            value={resourceTypeFilter}
            onChange={(e) => setFilter(setResourceTypeFilter)(e.target.value)}
            className={inputClass}
          >
            <option value="">Every resource</option>
            {RESOURCE_TYPES.map((rt) => (
              <option key={rt} value={rt}>
                {formatResourceType(rt)}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-neutral-600">Staff member</label>
          <select
            value={userIdFilter}
            onChange={(e) => setFilter(setUserIdFilter)(e.target.value)}
            className={inputClass}
          >
            <option value="">Everyone</option>
            {staff.map((s) => (
              <option key={s.userId} value={s.userId}>
                {s.fullName}
              </option>
            ))}
          </select>
        </div>

        {branches.length > 1 && (
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-600">Branch</label>
            <select
              value={branchIdFilter}
              onChange={(e) => setFilter(setBranchIdFilter)(e.target.value)}
              className={inputClass}
            >
              <option value="">Every branch</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="flex items-end gap-2">
          <label className="flex flex-col gap-1 text-xs font-medium text-neutral-600">
            From
            <input
              type="date"
              value={fromFilter}
              max={toFilter || undefined}
              onChange={(e) => setFilter(setFromFilter)(e.target.value)}
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-neutral-600">
            To
            <input
              type="date"
              value={toFilter}
              min={fromFilter || undefined}
              onChange={(e) => setFilter(setToFilter)(e.target.value)}
              className={inputClass}
            />
          </label>
        </div>

        {hasActiveFilters && (
          <button
            type="button"
            onClick={clearFilters}
            className="rounded-md px-2 py-1.5 text-sm text-neutral-500 underline decoration-dotted hover:text-neutral-700"
          >
            Clear filters
          </button>
        )}
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
                <th className="px-4 py-2 font-medium">Branch</th>
                <th className="px-4 py-2 font-medium">IP</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => {
                const isExpanded = expandedId === log.id;
                const hasMetadata = log.metadata && Object.keys(log.metadata).length > 0;
                // RC audit P1 fix (impersonation events rendering as raw
                // JSON) — a readable sentence replaces the JSON blob for
                // event types the formatter knows about (impersonation
                // start/exit/revoke today); everything else keeps the
                // existing expandable-JSON fallback.
                const readableSentence = formatAuditLogEntry(
                  { action: log.action, metadata: log.metadata, userFullName: log.userFullName },
                  { restaurantLabel: "this restaurant" },
                );
                const modifiers = formatAuditLogModifiers(log.metadata);
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
                      {modifiers && (
                        <span className="ml-1.5 rounded-full bg-amber-50 px-1.5 py-0.5 text-[11px] font-normal text-amber-700">
                          {modifiers}
                        </span>
                      )}
                      {hasMetadata && !readableSentence && (
                        <span className="ml-1.5 text-xs text-neutral-400">
                          {isExpanded ? "▲" : "▼"}
                        </span>
                      )}
                      {readableSentence && (
                        <p className="mt-1 max-w-md whitespace-normal font-normal text-neutral-600">
                          {readableSentence}
                        </p>
                      )}
                      {isExpanded && hasMetadata && !readableSentence && (
                        <pre className="mt-1 max-w-md overflow-x-auto rounded bg-neutral-50 p-2 text-xs text-neutral-600">
                          {JSON.stringify(log.metadata, null, 2)}
                        </pre>
                      )}
                    </td>
                    <td className="px-4 py-2 text-neutral-500">
                      {log.resourceType ? `${log.resourceType}${log.resourceId ? ` · ${log.resourceId.slice(0, 8)}` : ""}` : "—"}
                    </td>
                    <td className="px-4 py-2 text-neutral-500">{log.branchName ?? "—"}</td>
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
