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
        className="mb-4 inline-block text-sm text-neutral-500 hover:text-neutral-700"
      >
        &larr; Back to tickets
      </Link>

      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}
      {loading && <p className="text-sm text-neutral-400">Loading…</p>}

      {ticket && (
        <div className="rounded-lg border border-neutral-200 bg-white">
          <div className="border-b border-neutral-200 p-5">
            <div className="mb-1 flex items-center gap-2">
              <h1 className="text-lg font-semibold text-neutral-900">{ticket.subject}</h1>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[ticket.status]}`}>
                {STATUS_LABEL[ticket.status]}
              </span>
            </div>
            <p className="text-xs text-neutral-400">
              Filed by {ticket.createdByFullName ?? "Unknown"} on {formatDateTime(ticket.createdAt)}
            </p>
          </div>

          <div className="max-h-[28rem] space-y-3 overflow-y-auto p-5">
            {messages.map((m) => (
              <div
                key={m.id}
                className={`max-w-[85%] rounded-lg border p-3 text-sm ${
                  m.isFromPlatform
                    ? "ml-0 border-orange-100 bg-orange-50"
                    : "ml-auto border-neutral-100 bg-neutral-50"
                }`}
              >
                <div className="mb-1 text-xs font-medium text-neutral-500">
                  {m.isFromPlatform ? "RestroMitra support" : (m.authorFullName ?? "You")} ·{" "}
                  {formatDateTime(m.createdAt)}
                </div>
                <p className="whitespace-pre-wrap text-neutral-800">{m.body}</p>
              </div>
            ))}
          </div>

          <form onSubmit={sendReply} className="space-y-2 border-t border-neutral-200 p-5">
            {replyError && <p className="text-sm text-red-600">{replyError}</p>}
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
