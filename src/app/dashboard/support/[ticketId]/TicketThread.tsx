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

type Message = {
  id: string;
  body: string;
  isFromPlatform: boolean;
  createdAt: string;
  authorFullName: string | null;
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

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function TicketThread({ slug, ticketId }: { slug: string; ticketId: string }) {
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [reply, setReply] = useState("");
  const [replyBusy, setReplyBusy] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);

  async function load() {
    try {
      const res = await apiGet<{ ticket: Ticket; messages: Message[] }>(
        `/api/restaurants/${slug}/support/tickets/${ticketId}`,
      );
      setTicket(res.ticket);
      setMessages(res.messages);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load this ticket.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, ticketId]);

  async function sendReply(e: React.FormEvent) {
    e.preventDefault();
    if (!reply.trim()) return;
    setReplyBusy(true);
    setReplyError(null);
    try {
      await apiPost(`/api/restaurants/${slug}/support/tickets/${ticketId}/messages`, {
        body: reply,
      });
      setReply("");
      await load();
    } catch (err) {
      setReplyError(err instanceof ApiError ? err.message : "Could not send that reply.");
    } finally {
      setReplyBusy(false);
    }
  }

  return (
    <div>
      <Link
        href="/dashboard/support"
        className="mb-4 inline-block text-sm text-ink-muted hover:text-ink-secondary"
      >
        &larr; Back to tickets
      </Link>

      {error && <p className="mb-4 text-sm text-red-400">{error}</p>}
      {loading && <p className="text-sm text-ink-faint">Loading…</p>}

      {ticket && (
        <div className="rounded-lg border border-hairline bg-surface-2">
          <div className="border-b border-hairline p-5">
            <div className="mb-1 flex items-center gap-2">
              <h1 className="text-lg font-semibold text-ink">{ticket.subject}</h1>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[ticket.status]}`}>
                {STATUS_LABEL[ticket.status]}
              </span>
            </div>
            <p className="text-xs text-ink-faint">
              Filed by {ticket.createdByFullName ?? "Unknown"} on {formatDateTime(ticket.createdAt)}
            </p>
          </div>

          <div className="max-h-[28rem] space-y-3 overflow-y-auto p-5">
            {messages.map((m) => (
              <div
                key={m.id}
                className={`max-w-[85%] rounded-lg border p-3 text-sm ${
                  m.isFromPlatform
                    ? "ml-0 border-orange-100 bg-orange-500/15"
                    : "ml-auto border-hairline/60 bg-surface-1"
                }`}
              >
                <div className="mb-1 text-xs font-medium text-ink-muted">
                  {m.isFromPlatform ? "RestroKendra support" : (m.authorFullName ?? "You")} ·{" "}
                  {formatDateTime(m.createdAt)}
                </div>
                <p className="whitespace-pre-wrap text-ink">{m.body}</p>
              </div>
            ))}
          </div>

          <form onSubmit={sendReply} className="space-y-2 border-t border-hairline p-5">
            {replyError && <p className="text-sm text-red-400">{replyError}</p>}
            <textarea
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              placeholder="Write a reply…"
              rows={3}
              maxLength={4000}
              className="input"
            />
            <button
              type="submit"
              disabled={replyBusy || !reply.trim()}
              className="rounded-md bg-orange-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-orange-700 disabled:opacity-60"
            >
              {replyBusy ? "Sending…" : "Send reply"}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
