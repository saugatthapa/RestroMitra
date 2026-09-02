"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { apiGet, ApiError } from "@/lib/api-client";

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
  restaurantId: string;
  restaurantName: string;
};

const STATUS_BADGE: Record<TicketStatus, string> = {
  open: "bg-sky-500/15 text-sky-400",
  in_progress: "bg-amber-500/15 text-amber-400",
  resolved: "bg-emerald-500/15 text-emerald-400",
  closed: "bg-surface-1 text-ink-muted",
};

const STATUS_LABEL: Record<TicketStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  resolved: "Resolved",
  closed: "Closed",
};

const PRIORITY_BADGE: Record<TicketPriority, string> = {
  low: "bg-surface-1 text-ink-muted",
  normal: "bg-surface-1 text-ink-secondary",
  high: "bg-red-500/15 text-red-400",
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

/**
 * Gap audit P1 — the admin queue for tenant-filed support tickets.
 * `status` filters server-side (a fresh GET per change — see the API
 * route's own comment); `restaurantQuery` is a lightweight client-side
 * substring filter over the already-fetched page's restaurantName, no
 * separate restaurant picker/autocomplete needed for a queue this size.
 */
export function AdminSupportTicketsBoard() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<TicketStatus | "">("");
  const [restaurantQuery, setRestaurantQuery] = useState("");

  async function load() {
    setLoading(true);
    try {
      const qs = status ? `?status=${status}` : "";
      const res = await apiGet<{ tickets: Ticket[] }>(`/api/admin/support-tickets${qs}`);
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
  }, [status]);

  const visibleTickets = useMemo(() => {
    const q = restaurantQuery.trim().toLowerCase();
    if (!q) return tickets;
    return tickets.filter((t) => t.restaurantName.toLowerCase().includes(q));
  }, [tickets, restaurantQuery]);

  return (
    <div className="rounded-lg border border-hairline bg-surface-2">
      <div className="flex flex-wrap items-center gap-3 border-b border-hairline p-5">
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as TicketStatus | "")}
          className="input w-auto"
        >
          <option value="">All statuses</option>
          <option value="open">Open</option>
          <option value="in_progress">In progress</option>
          <option value="resolved">Resolved</option>
          <option value="closed">Closed</option>
        </select>
        <input
          value={restaurantQuery}
          onChange={(e) => setRestaurantQuery(e.target.value)}
          placeholder="Filter by restaurant name…"
          className="input w-auto flex-1 min-w-[200px]"
        />
      </div>

      {error && <p className="p-5 text-sm text-red-400">{error}</p>}

      <div className="divide-y divide-hairline/60">
        {!loading && visibleTickets.length === 0 && (
          <p className="p-5 text-center text-sm text-ink-faint">No tickets match.</p>
        )}
        {visibleTickets.map((t) => (
          <Link
            key={t.id}
            href={`/admin/support-tickets/${t.id}`}
            className="flex items-center justify-between gap-4 p-5 hover:bg-surface-1"
          >
            <div>
              <div className="mb-1 flex items-center gap-2">
                <span className="text-sm font-medium text-ink">{t.subject}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[t.status]}`}>
                  {STATUS_LABEL[t.status]}
                </span>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${PRIORITY_BADGE[t.priority]}`}>
                  {t.priority}
                </span>
              </div>
              <p className="text-xs text-ink-faint">
                {t.restaurantName} · Filed by {t.createdByFullName ?? "Unknown"} · Last activity{" "}
                {formatDateTime(t.updatedAt)}
              </p>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
