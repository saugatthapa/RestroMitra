"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiGet, apiPost, ApiError } from "@/lib/api-client";

type TicketStatus = "open" | "in_progress" | "resolved" | "closed";
type TicketPriority = "low" | "normal" | "high";

type Ticket = {
  id: string;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  createdAt: string;
  updatedAt: string;
  createdByFullName: string | null;
};

const STATUS_BADGE: Record<TicketStatus, string> = {
  open: "bg-sky-50 text-sky-700",
  in_progress: "bg-amber-50 text-amber-700",
  resolved: "bg-emerald-50 text-emerald-700",
  closed: "bg-neutral-100 text-neutral-500",
};

const STATUS_LABEL: Record<TicketStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  resolved: "Resolved",
  closed: "Closed",
};

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function SupportTicketsBoard({ slug }: { slug: string }) {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [priority, setPriority] = useState<TicketPriority>("normal");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  async function load() {
    try {
      const res = await apiGet<{ tickets: Ticket[] }>(
        `/api/restaurants/${slug}/support/tickets`,
      );
      setTickets(res.tickets);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load support tickets.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateBusy(true);
    setCreateError(null);
    try {
      await apiPost(`/api/restaurants/${slug}/support/tickets`, { subject, body, priority });
      setCreating(false);
      setSubject("");
      setBody("");
      setPriority("normal");
      await load();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Could not create that ticket.");
    } finally {
      setCreateBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-neutral-200 bg-white">
      <div className="flex items-center justify-between border-b border-neutral-200 p-5">
        <h2 className="text-sm font-semibold text-neutral-900">Your tickets</h2>
        {!creating && (
          <button
            type="button"
            onClick={() => {
              setCreating(true);
              setCreateError(null);
            }}
            className="rounded-md bg-orange-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-orange-700"
          >
            New ticket
          </button>
        )}
      </div>

      {creating && (
        <form onSubmit={handleCreate} className="space-y-3 border-b border-neutral-200 p-5">
          {createError && <p className="text-sm text-red-600">{createError}</p>}
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject"
            required
            maxLength={200}
            className="input"
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Describe the issue…"
            rows={4}
            required
            maxLength={4000}
            className="input"
          />
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value as TicketPriority)}
            className="input"
          >
            <option value="low">Low priority</option>
            <option value="normal">Normal priority</option>
            <option value="high">High priority</option>
          </select>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={createBusy}
              className="rounded-md bg-orange-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-orange-700 disabled:opacity-60"
            >
              {createBusy ? "Submitting…" : "Submit ticket"}
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
        {!loading && tickets.length === 0 && (
          <p className="p-5 text-center text-sm text-neutral-400">
            No support tickets yet. Filed a ticket? It&apos;ll show up here once submitted.
          </p>
        )}
        {tickets.map((t) => (
          <Link
            key={t.id}
            href={`/dashboard/support/${t.id}`}
            className="flex items-center justify-between gap-4 p-5 hover:bg-neutral-50"
          >
            <div>
              <div className="mb-1 flex items-center gap-2">
                <span className="text-sm font-medium text-neutral-900">{t.subject}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[t.status]}`}>
                  {STATUS_LABEL[t.status]}
                </span>
              </div>
              <p className="text-xs text-neutral-400">
                Filed by {t.createdByFullName ?? "Unknown"} · Last activity {formatDateTime(t.updatedAt)}
              </p>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
