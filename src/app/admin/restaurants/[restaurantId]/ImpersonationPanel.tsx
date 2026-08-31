"use client";

import { useState } from "react";
import { apiPost, ApiError } from "@/lib/api-client";

/**
 * Platform Control Center (Phase 8) — the admin dashboard's "Impersonate"
 * action (spec item 23). Starts a dedicated impersonation session (see
 * src/lib/auth/impersonation.ts) and, on success, navigates to /dashboard
 * — a full navigation (not client-side routing) so the freshly-set
 * impersonation cookie is definitely picked up by dashboard/layout.tsx on
 * the very next request.
 *
 * Deliberately requires typing a reason AND checking the confirmation box
 * before the button enables — spec item 23's mockup calls for both a
 * mandatory reason field and an explicit "I understand this action is
 * logged" acknowledgment, not just one or the other.
 */
export function ImpersonationPanel({
  restaurantId,
  restaurantName,
}: {
  restaurantId: string;
  restaurantName: string;
}) {
  const [reason, setReason] = useState("");
  const [mode, setMode] = useState<"read_only" | "write">("read_only");
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canStart = reason.trim().length >= 3 && acknowledged && !busy;

  async function start() {
    if (!canStart) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost("/api/admin/impersonation/start", { restaurantId, reason, mode });
      window.location.href = "/dashboard";
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start impersonation.");
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
      <h2 className="mb-1 text-sm font-semibold text-amber-950">Impersonate</h2>
      <p className="mb-3 text-xs text-amber-800">
        Opens {restaurantName}&apos;s dashboard as this admin, in a separate, time-boxed session
        (30 minutes). Your own platform login is unaffected. Every action taken is logged against
        your identity, not the restaurant&apos;s.
      </p>

      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason (required, recorded in the audit log)…"
        rows={2}
        className="input mb-3"
      />

      <label className="mb-3 block text-xs text-amber-900">
        Access level
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as "read_only" | "write")}
          className="input mt-1"
        >
          <option value="read_only">Read-only (view dashboard, orders, reports…)</option>
          <option value="write">Read/write (also make changes)</option>
        </select>
      </label>

      <label className="mb-3 flex items-start gap-2 text-xs text-amber-900">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => setAcknowledged(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          I understand this action is logged, time-limited, and that platform-level settings
          (billing, AI provider keys, other tenants&apos; data) remain inaccessible.
        </span>
      </label>

      {error && <p className="mb-3 text-sm text-red-700">{error}</p>}

      <button
        disabled={!canStart}
        onClick={start}
        className="inline-flex items-center justify-center rounded-lg bg-amber-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? "Starting…" : "Start impersonation"}
      </button>
    </div>
  );
}
