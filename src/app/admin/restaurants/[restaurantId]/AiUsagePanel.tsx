"use client";

import { useState } from "react";
import { apiPatch, ApiError } from "@/lib/api-client";

/**
 * Platform Control Center (Phase 7) — the per-restaurant half of the AI
 * Provider Control Center's admin surface. Shows this restaurant's
 * effective monthly AI-assistant quota (override, else plan limit, else
 * trial default — see aiMonthlyRequestLimitForRestaurant in plans-db.ts)
 * and this month's usage so far, and lets an admin set or clear an
 * explicit per-tenant override.
 */
export function AiUsagePanel({
  restaurantId,
  aiMonthlyRequestLimitOverride,
  aiMonthlyRequestLimit,
  aiRequestsThisMonth,
  onSaved,
}: {
  restaurantId: string;
  aiMonthlyRequestLimitOverride: number | null;
  aiMonthlyRequestLimit: number | null;
  aiRequestsThisMonth: number;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(
    aiMonthlyRequestLimitOverride === null ? "" : String(aiMonthlyRequestLimitOverride),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(nextOverride: number | null) {
    setBusy(true);
    setError(null);
    try {
      await apiPatch(`/api/admin/restaurants/${restaurantId}/ai-limit`, {
        aiMonthlyRequestLimitOverride: nextOverride,
      });
      setEditing(false);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save that limit.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-hairline bg-surface-2 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">AI assistant usage</h2>
        {!editing && (
          <button
            type="button"
            onClick={() => {
              setEditing(true);
              setError(null);
            }}
            className="rounded-md border border-hairline-strong px-3 py-1.5 text-sm font-medium text-ink-secondary hover:bg-surface-1"
          >
            Set override
          </button>
        )}
      </div>
      <p className="mt-2 text-sm text-ink-secondary">
        {aiRequestsThisMonth} used this month, of{" "}
        {aiMonthlyRequestLimit === null ? "an unlimited" : aiMonthlyRequestLimit} monthly quota
        {aiMonthlyRequestLimitOverride !== null ? " (admin override)" : ""}.{" "}
        Resets on the 1st.
      </p>
      {editing && (
        <div className="mt-3 flex items-end gap-2">
          <label className="block text-sm">
            <span className="mb-1 block text-ink-secondary">Override (blank = use plan&apos;s limit)</span>
            <input
              type="number"
              min={0}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="w-40 rounded-md border border-hairline-strong px-3 py-1.5 text-sm text-ink focus:border-hairline-strong focus:outline-none"
            />
          </label>
          <button
            type="button"
            disabled={busy}
            onClick={() => save(value === "" ? null : Number(value))}
            className="rounded-md bg-orange-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setEditing(false);
              setValue(aiMonthlyRequestLimitOverride === null ? "" : String(aiMonthlyRequestLimitOverride));
            }}
            className="rounded-md border border-hairline-strong px-3 py-1.5 text-sm font-medium text-ink-secondary hover:bg-surface-1 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Cancel
          </button>
        </div>
      )}
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    </div>
  );
}
