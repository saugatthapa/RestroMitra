"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiPost } from "@/lib/api-client";

/**
 * Phase 8 (Platform Control Center) — persistent, un-hideable banner shown
 * across every /dashboard/* page while a platform admin is impersonating
 * this restaurant. Rendered by dashboard/layout.tsx OUTSIDE/above
 * <DashboardShell>, not inside it, specifically so it can never be
 * scrolled past, collapsed by the sidebar, or otherwise hidden by
 * anything DashboardShell itself renders — every page under this layout
 * gets it unconditionally, with no per-page opt-out.
 *
 * Deliberately has no dismiss/close control — spec item 22 ("persistent
 * warning banner... admin cannot accidentally forget they're
 * impersonating"). The only way off this screen is the Exit button, which
 * actually ends the session.
 */
export function ImpersonationBanner({
  restaurantName,
  reason,
  mode,
  startedAt,
  expiresAt,
}: {
  restaurantName: string;
  reason: string;
  mode: "read_only" | "write";
  startedAt: string;
  expiresAt: string;
}) {
  const router = useRouter();
  const [exiting, setExiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(() => formatRemaining(expiresAt));

  useEffect(() => {
    const id = setInterval(() => setRemaining(formatRemaining(expiresAt)), 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  async function handleExit() {
    setExiting(true);
    setError(null);
    try {
      await apiPost("/api/admin/impersonation/exit", {});
      router.replace("/admin/restaurants");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to exit impersonation.");
      setExiting(false);
    }
  }

  return (
    <div className="sticky top-0 z-[100] flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-amber-700 bg-amber-500 px-4 py-2 text-sm font-medium text-amber-950">
      <span className="inline-flex items-center gap-1.5 font-semibold uppercase tracking-wide">
        <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path
            fillRule="evenodd"
            d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495ZM10 6a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 10 6Zm0 8a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
            clipRule="evenodd"
          />
        </svg>
        Impersonating
      </span>
      <span>
        Viewing <strong>{restaurantName}</strong> as {mode === "write" ? "read/write" : "read-only"}
      </span>
      <span className="text-amber-300/80">Reason: {reason}</span>
      <span className="text-amber-300/80">
        Started {new Date(startedAt).toLocaleTimeString()} · Expires in {remaining}
      </span>
      {error && <span className="font-semibold text-red-300">{error}</span>}
      <button
        type="button"
        onClick={handleExit}
        disabled={exiting}
        className="ml-auto rounded-md bg-amber-950 px-3 py-1 text-xs font-semibold text-amber-50 transition hover:bg-amber-900 disabled:opacity-60"
      >
        {exiting ? "Exiting…" : "Exit impersonation"}
      </button>
    </div>
  );
}

function formatRemaining(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
