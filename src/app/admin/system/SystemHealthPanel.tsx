"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPost, ApiError } from "@/lib/api-client";

type SubscriptionStatus = "trialing" | "active" | "past_due" | "paused" | "cancelled" | "expired";

type SystemData = {
  health: {
    db: { ok: boolean; latencyMs: number };
    restaurants: {
      total: number;
      active: number;
      suspended: number;
      byStatus: Record<SubscriptionStatus, number>;
    };
    signupsLast24h: number;
    appUptimeSeconds: number;
    serverTime: string;
  };
  maintenanceMode: {
    enabled: boolean;
    message: string | null;
    reason: string | null;
    enabledAt: string | null;
    enabledByName: string | null;
  };
};

function formatUptime(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours === 0) return `${minutes}m`;
  const days = Math.floor(hours / 24);
  if (days === 0) return `${hours}h ${minutes}m`;
  return `${days}d ${hours % 24}h`;
}

export function SystemHealthPanel() {
  const [data, setData] = useState<SystemData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [message, setMessage] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);

  const [purgeBusy, setPurgeBusy] = useState(false);
  const [purgeError, setPurgeError] = useState<string | null>(null);
  const [purgeResult, setPurgeResult] = useState<{
    retentionDays: number;
    recordsPurged: number;
    photosDeleted: number;
    failures: number;
  } | null>(null);

  async function load() {
    try {
      const res = await apiGet<SystemData>("/api/admin/system");
      setData(res);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load system health.");
    }
  }

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, []);

  async function enableMaintenance() {
    if (!reason.trim()) {
      setToggleError("Enter a reason first.");
      return;
    }
    setBusy(true);
    setToggleError(null);
    try {
      await apiPost("/api/admin/system/maintenance-mode", {
        enabled: true,
        message: message.trim() || undefined,
        reason,
      });
      setReason("");
      setMessage("");
      await load();
    } catch (err) {
      setToggleError(err instanceof ApiError ? err.message : "Could not enable maintenance mode.");
    } finally {
      setBusy(false);
    }
  }

  async function disableMaintenance() {
    setBusy(true);
    setToggleError(null);
    try {
      await apiPost("/api/admin/system/maintenance-mode", { enabled: false });
      await load();
    } catch (err) {
      setToggleError(err instanceof ApiError ? err.message : "Could not disable maintenance mode.");
    } finally {
      setBusy(false);
    }
  }

  async function purgeAttendancePhotos() {
    if (
      !confirm(
        "Permanently delete every attendance photo past its retention window? This can't be undone.",
      )
    ) {
      return;
    }
    setPurgeBusy(true);
    setPurgeError(null);
    try {
      const res = await apiPost<{
        retentionDays: number;
        recordsPurged: number;
        photosDeleted: number;
        failures: number;
      }>("/api/admin/system/purge-attendance-photos", {});
      setPurgeResult(res);
    } catch (err) {
      setPurgeError(err instanceof ApiError ? err.message : "Could not run the attendance photo purge.");
    } finally {
      setPurgeBusy(false);
    }
  }

  if (error && !data) return <p className="text-sm text-red-600">{error}</p>;
  if (!data) return <p className="text-sm text-neutral-400">Loading…</p>;

  const { health, maintenanceMode } = data;

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-neutral-200 bg-white p-5">
        <h2 className="mb-4 text-sm font-semibold text-neutral-900">Operational health</h2>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Database" value={health.db.ok ? "OK" : "Unreachable"} accent={health.db.ok} />
          <Stat label="DB latency" value={`${health.db.latencyMs} ms`} />
          <Stat label="Restaurants" value={String(health.restaurants.total)} />
          <Stat label="Suspended" value={String(health.restaurants.suspended)} />
          <Stat label="Signups (24h)" value={String(health.signupsLast24h)} />
          <Stat label="App uptime" value={formatUptime(health.appUptimeSeconds)} />
        </div>
        <div className="mt-4">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Subscription status breakdown
          </h3>
          <div className="flex flex-wrap gap-2 text-xs">
            {Object.entries(health.restaurants.byStatus).map(([status, n]) => (
              <span key={status} className="rounded-full bg-neutral-100 px-2.5 py-1 text-neutral-700">
                {status}: {n}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-neutral-200 bg-white p-5">
        <h2 className="mb-1 text-sm font-semibold text-neutral-900">Maintenance mode</h2>
        <p className="mb-4 text-xs text-neutral-500">
          When enabled, every restaurant&apos;s dashboard and API requests are blocked with a
          maintenance notice — except platform admins and active impersonation sessions, who stay
          fully able to work. Every action taken while this is on is tagged in the audit log.
        </p>

        {maintenanceMode.enabled ? (
          <div>
            <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <p className="font-medium">Maintenance mode is ON</p>
              {maintenanceMode.message && <p className="mt-1">&quot;{maintenanceMode.message}&quot;</p>}
              <p className="mt-1 text-xs text-amber-700">
                Reason: {maintenanceMode.reason} · Enabled by {maintenanceMode.enabledByName ?? "—"}
                {maintenanceMode.enabledAt &&
                  ` · ${new Date(maintenanceMode.enabledAt).toLocaleString()}`}
              </p>
            </div>
            {toggleError && <p className="mb-2 text-sm text-red-600">{toggleError}</p>}
            <button
              type="button"
              disabled={busy}
              onClick={disableMaintenance}
              className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-60"
            >
              {busy ? "Disabling…" : "Disable maintenance mode"}
            </button>
          </div>
        ) : (
          <div>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Message shown to blocked users (optional)…"
              rows={2}
              className="input mb-2"
            />
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reason (required, recorded in the audit log)…"
              rows={2}
              className="input mb-2"
            />
            {toggleError && <p className="mb-2 text-sm text-red-600">{toggleError}</p>}
            <button
              type="button"
              disabled={busy}
              onClick={enableMaintenance}
              className="rounded-md border border-red-200 bg-white px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-60"
            >
              {busy ? "Enabling…" : "Enable maintenance mode"}
            </button>
          </div>
        )}
      </div>

      <div className="rounded-xl border border-neutral-200 bg-white p-5">
        <h2 className="mb-1 text-sm font-semibold text-neutral-900">Attendance photo retention</h2>
        <p className="mb-4 text-xs text-neutral-500">
          Permanently deletes every attendance selfie past its restaurant&apos;s retention window (set via
          ATTENDANCE_PHOTO_RETENTION_DAYS — 90 days by default) and clears the DB record pointing to it.
          This app has no built-in scheduler, so run this periodically from an external cron, or trigger it
          manually here.
        </p>
        {purgeError && <p className="mb-2 text-sm text-red-600">{purgeError}</p>}
        {purgeResult && (
          <p className="mb-2 rounded-lg bg-neutral-50 px-3 py-2 text-xs text-neutral-600">
            Retention: {purgeResult.retentionDays} days · {purgeResult.recordsPurged} record(s) matched ·{" "}
            {purgeResult.photosDeleted} photo(s) deleted
            {purgeResult.failures > 0 && ` · ${purgeResult.failures} failure(s) — see server logs`}
          </p>
        )}
        <button
          type="button"
          disabled={purgeBusy}
          onClick={purgeAttendancePhotos}
          className="rounded-md border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-60"
        >
          {purgeBusy ? "Purging…" : "Purge expired attendance photos now"}
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <p className="text-xs text-neutral-500">{label}</p>
      <p
        className={`text-lg font-semibold tabular-nums ${accent === false ? "text-red-600" : "text-neutral-900"}`}
      >
        {value}
      </p>
    </div>
  );
}
