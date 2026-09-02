"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiGet, apiPost, ApiError } from "@/lib/api-client";

type ActiveSession = {
  id: string;
  adminUserId: string;
  adminFullName: string;
  targetRestaurantId: string;
  targetRestaurantName: string;
  reason: string;
  mode: "read_only" | "write";
  startedAt: string;
  expiresAt: string;
};

/**
 * Platform Control Center (Phase 8) — the "active impersonation" status
 * view (spec item 24), with a "Revoke" control (spec item 25) for a
 * platform owner to force-end someone else's session. Renders nothing
 * when there are none active, so it never clutters the /admin overview
 * for the common case. Fetching /api/admin/impersonation/active itself
 * doubles as the permission check — a caller without MANAGE_SUPPORT gets
 * a 403 and this component just quietly renders nothing rather than
 * surfacing an error banner for something they weren't looking for.
 */
export function ActiveImpersonationSessions() {
  const [sessions, setSessions] = useState<ActiveSession[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const res = await apiGet<{ sessions: ActiveSession[] }>("/api/admin/impersonation/active");
      setSessions(res.sessions);
    } catch {
      setSessions([]);
    }
  }

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, []);

  async function revoke(sessionId: string) {
    setBusyId(sessionId);
    setError(null);
    try {
      await apiPost("/api/admin/impersonation/revoke", { sessionId });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not revoke this session.");
    } finally {
      setBusyId(null);
    }
  }

  if (!sessions || sessions.length === 0) return null;

  return (
    <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 p-4">
      <h2 className="mb-3 text-sm font-semibold text-amber-950">Active impersonation sessions</h2>
      {error && <p className="mb-3 text-sm text-red-700">{error}</p>}
      <div className="space-y-2">
        {sessions.map((s) => (
          <div
            key={s.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm"
          >
            <div>
              <p className="font-medium text-neutral-800">
                {s.adminFullName} →{" "}
                <Link href={`/admin/restaurants/${s.targetRestaurantId}`} className="underline">
                  {s.targetRestaurantName}
                </Link>{" "}
                <span className="text-xs text-neutral-500">({s.mode === "write" ? "read/write" : "read-only"})</span>
              </p>
              <p className="text-xs text-neutral-500">
                {s.reason} · expires {new Date(s.expiresAt).toLocaleTimeString()}
              </p>
            </div>
            <button
              disabled={busyId === s.id}
              onClick={() => revoke(s.id)}
              className="inline-flex items-center justify-center rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busyId === s.id ? "Revoking…" : "Revoke"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
