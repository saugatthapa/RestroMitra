"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPost, apiPatch, apiDelete, ApiError } from "@/lib/api-client";

type Severity = "info" | "warning" | "critical";

type Announcement = {
  id: string;
  title: string;
  body: string;
  severity: Severity;
  isActive: boolean;
  startsAt: string | null;
  endsAt: string | null;
  createdAt: string;
};

const SEVERITY_BADGE: Record<Severity, string> = {
  info: "bg-sky-50 text-sky-700",
  warning: "bg-amber-50 text-amber-700",
  critical: "bg-red-50 text-red-700",
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

export function AnnouncementsBoard() {
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [severity, setSeverity] = useState<Severity>("info");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    try {
      const res = await apiGet<{ announcements: Announcement[] }>("/api/admin/announcements");
      setAnnouncements(res.announcements);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load announcements.");
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateBusy(true);
    setCreateError(null);
    try {
      await apiPost("/api/admin/announcements", { title, body, severity });
      setCreating(false);
      setTitle("");
      setBody("");
      setSeverity("info");
      await load();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Could not create that announcement.");
    } finally {
      setCreateBusy(false);
    }
  }

  async function toggle(a: Announcement) {
    setBusyId(a.id);
    try {
      await apiPatch(`/api/admin/announcements/${a.id}`, { isActive: !a.isActive });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update that announcement.");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(a: Announcement) {
    setBusyId(a.id);
    try {
      await apiDelete(`/api/admin/announcements/${a.id}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete that announcement.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-neutral-200 bg-white">
        <div className="flex items-center justify-between border-b border-neutral-200 p-5">
          <h2 className="text-sm font-semibold text-neutral-900">All announcements</h2>
          {!creating && (
            <button
              type="button"
              onClick={() => {
                setCreating(true);
                setCreateError(null);
              }}
              className="rounded-md bg-orange-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-orange-700"
            >
              New announcement
            </button>
          )}
        </div>

        {creating && (
          <form onSubmit={handleCreate} className="space-y-3 border-b border-neutral-200 p-5">
            {createError && <p className="text-sm text-red-600">{createError}</p>}
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Title"
              required
              className="input"
            />
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Message shown to every restaurant…"
              rows={2}
              required
              className="input"
            />
            <select value={severity} onChange={(e) => setSeverity(e.target.value as Severity)} className="input">
              <option value="info">Info</option>
              <option value="warning">Warning</option>
              <option value="critical">Critical</option>
            </select>
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={createBusy}
                className="rounded-md bg-orange-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-orange-700 disabled:opacity-60"
              >
                {createBusy ? "Creating…" : "Create"}
              </button>
              <button
                type="button"
                onClick={() => setCreating(false)}
                className="rounded-md border border-neutral-200 px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-50"
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {error && <p className="p-5 text-sm text-red-600">{error}</p>}

        <div className="divide-y divide-neutral-100">
          {announcements.length === 0 && (
            <p className="p-5 text-center text-sm text-neutral-400">No announcements yet.</p>
          )}
          {announcements.map((a) => (
            <div key={a.id} className="flex items-start justify-between gap-4 p-5">
              <div>
                <div className="mb-1 flex items-center gap-2">
                  <span className="text-sm font-medium text-neutral-900">{a.title}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${SEVERITY_BADGE[a.severity]}`}>
                    {a.severity}
                  </span>
                  {!a.isActive && (
                    <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-500">
                      Inactive
                    </span>
                  )}
                </div>
                <p className="text-sm text-neutral-600">{a.body}</p>
                <p className="mt-1 text-xs text-neutral-400">Created {formatDate(a.createdAt)}</p>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  disabled={busyId === a.id}
                  onClick={() => toggle(a)}
                  className="rounded-md border border-neutral-200 px-2.5 py-1 text-xs text-neutral-600 hover:bg-neutral-50 disabled:opacity-60"
                >
                  {a.isActive ? "Deactivate" : "Activate"}
                </button>
                <button
                  type="button"
                  disabled={busyId === a.id}
                  onClick={() => remove(a)}
                  className="rounded-md border border-red-200 px-2.5 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-60"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
