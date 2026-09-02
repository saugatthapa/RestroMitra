"use client";

import { useState } from "react";

type Announcement = {
  id: string;
  title: string;
  body: string;
  severity: "info" | "warning" | "critical";
};

const SEVERITY_CLASSES: Record<Announcement["severity"], string> = {
  info: "border-sky-500/30 bg-sky-500/15 text-sky-300",
  warning: "border-amber-500/30 bg-amber-500/15 text-amber-300",
  critical: "border-red-500/30 bg-red-500/15 text-red-300",
};

/**
 * Platform Control Center (Phase 10) — platform-wide announcements shown
 * on every /dashboard/* page. Dismissal is local component state only
 * (not persisted server-side or in browser storage) — it survives
 * client-side navigation within the dashboard (this layout doesn't
 * remount on every page) but resets on a full reload, a deliberate scope
 * decision rather than building a per-user "seen announcements" table for
 * what's meant to be a lightweight, ephemeral notice mechanism.
 */
export function AnnouncementBanner({ announcements }: { announcements: Announcement[] }) {
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const visible = announcements.filter((a) => !dismissedIds.has(a.id));

  if (visible.length === 0) return null;

  return (
    <div className="space-y-1 px-4 pt-2">
      {visible.map((a) => (
        <div
          key={a.id}
          className={`flex items-start justify-between gap-3 rounded-lg border px-3 py-2 text-sm ${SEVERITY_CLASSES[a.severity]}`}
        >
          <div>
            <span className="font-semibold">{a.title}</span>
            <span className="ml-2">{a.body}</span>
          </div>
          <button
            type="button"
            onClick={() => setDismissedIds((prev) => new Set(prev).add(a.id))}
            className="shrink-0 text-current opacity-60 hover:opacity-100"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
