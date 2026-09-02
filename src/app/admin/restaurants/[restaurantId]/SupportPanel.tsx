"use client";

import { useState } from "react";
import { apiGet, apiPost, apiDelete, ApiError } from "@/lib/api-client";
import { SUPPORT_TAGS, SUPPORT_TAG_LABELS, type SupportTag } from "@/lib/support/tags";
import { HEALTH_BAND_LABELS, type HealthBand } from "@/lib/support/health-score";

export type SupportPanelData = {
  healthScore: { score: number; band: HealthBand; reasons: { label: string; delta: number }[] } | null;
  supportTags: { id: string; tag: SupportTag; createdAt: string }[];
  supportNotes: {
    id: string;
    note: string;
    createdAt: string;
    authorUserId: string | null;
    authorFullName: string | null;
  }[];
  staff: {
    userRoleId: string;
    userId: string;
    fullName: string;
    phone: string;
    role: string;
    isActive: boolean;
  }[];
};

const BAND_CLASSES: Record<HealthBand, string> = {
  healthy: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  watch: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  at_risk: "bg-red-500/15 text-red-400 border-red-500/30",
};

type ActiveSession = {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  activeRestaurantId: string | null;
  createdAt: string;
  expiresAt: string;
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
 * Platform Control Center (Phase 9) — Support tooling. Renders nothing
 * beyond a "not available" note if the caller doesn't hold MANAGE_SUPPORT
 * (the parent route returns healthScore: null / empty arrays in that
 * case — see the route's own comment) rather than erroring, since this
 * panel sits on a page a plain VIEW_TENANTS-only platform_viewer can
 * still legitimately reach.
 */
export function SupportPanel({
  restaurantId,
  healthScore,
  supportTags,
  supportNotes,
  staff,
  onChanged,
}: SupportPanelData & { restaurantId: string; onChanged: () => void }) {
  const [noteText, setNoteText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revokedMessage, setRevokedMessage] = useState<string | null>(null);

  const availableTags = SUPPORT_TAGS.filter((t) => !supportTags.some((existing) => existing.tag === t));

  async function addNote() {
    if (!noteText.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/api/admin/restaurants/${restaurantId}/support-notes`, { note: noteText });
      setNoteText("");
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add note.");
    } finally {
      setBusy(false);
    }
  }

  async function removeNote(noteId: string) {
    setBusy(true);
    setError(null);
    try {
      await apiDelete(`/api/admin/restaurants/${restaurantId}/support-notes/${noteId}`);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not remove note.");
    } finally {
      setBusy(false);
    }
  }

  async function addTag(tag: SupportTag) {
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/api/admin/restaurants/${restaurantId}/support-tags`, { tag });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add tag.");
    } finally {
      setBusy(false);
    }
  }

  async function removeTag(tagId: string) {
    setBusy(true);
    setError(null);
    try {
      await apiDelete(`/api/admin/restaurants/${restaurantId}/support-tags/${tagId}`);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not remove tag.");
    } finally {
      setBusy(false);
    }
  }

  async function revokeSessions(userId: string, fullName: string) {
    setBusy(true);
    setError(null);
    setRevokedMessage(null);
    try {
      const res = await apiPost<{ sessionsRevoked: number }>(
        `/api/admin/restaurants/${restaurantId}/staff/${userId}/revoke-sessions`,
        {},
      );
      setRevokedMessage(`${fullName}: signed out of ${res.sessionsRevoked} active session(s).`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not revoke sessions.");
    } finally {
      setBusy(false);
    }
  }

  if (healthScore === null) {
    return null;
  }

  return (
    <div className="mt-6 rounded-xl border border-hairline bg-surface-2 p-4">
      <h2 className="mb-3 text-sm font-semibold text-ink">Support</h2>
      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
      {revokedMessage && <p className="mb-3 text-sm text-emerald-400">{revokedMessage}</p>}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div>
          <div className="mb-4">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">
              Health score
            </h3>
            <div className="flex items-center gap-3">
              <span className="text-2xl font-semibold tabular-nums text-ink">
                {healthScore.score}
              </span>
              <span
                className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${BAND_CLASSES[healthScore.band]}`}
              >
                {HEALTH_BAND_LABELS[healthScore.band]}
              </span>
            </div>
            {healthScore.reasons.length > 0 ? (
              <ul className="mt-2 space-y-1 text-xs text-ink-secondary">
                {healthScore.reasons.map((r, i) => (
                  <li key={i}>
                    {r.label} <span className="text-ink-faint">({r.delta})</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-xs text-ink-muted">No issues found.</p>
            )}
          </div>

          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">
              Status tags
            </h3>
            <div className="mb-2 flex flex-wrap gap-1.5">
              {supportTags.length === 0 && <p className="text-xs text-ink-faint">No tags.</p>}
              {supportTags.map((t) => (
                <span
                  key={t.id}
                  className="inline-flex items-center gap-1 rounded-full bg-surface-1 px-2.5 py-1 text-xs font-medium text-ink-secondary"
                >
                  {SUPPORT_TAG_LABELS[t.tag]}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => removeTag(t.id)}
                    className="text-ink-faint hover:text-red-400"
                    aria-label={`Remove ${SUPPORT_TAG_LABELS[t.tag]}`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            {availableTags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {availableTags.map((t) => (
                  <button
                    key={t}
                    type="button"
                    disabled={busy}
                    onClick={() => addTag(t)}
                    className="rounded-full border border-hairline px-2.5 py-1 text-xs text-ink-secondary transition hover:bg-surface-1 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    + {SUPPORT_TAG_LABELS[t]}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="mt-4">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">
              Staff sessions
            </h3>
            <p className="mb-2 text-xs text-ink-faint">
              Expand a staff member to see their actual active sessions (device, IP, created/expires)
              and revoke one at a time — or use &quot;Revoke all&quot; for a compromised-account sweep.
            </p>
            <div className="space-y-1.5">
              {staff.length === 0 && <p className="text-xs text-ink-faint">No active staff.</p>}
              {staff.map((s) => (
                <StaffSessionRow
                  key={s.userRoleId}
                  restaurantId={restaurantId}
                  userId={s.userId}
                  fullName={s.fullName}
                  role={s.role}
                  busy={busy}
                  onRevokeAll={() => revokeSessions(s.userId, s.fullName)}
                  onError={setError}
                />
              ))}
            </div>
          </div>
        </div>

        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">
            Internal notes
          </h3>
          <p className="mb-2 text-xs text-ink-faint">
            Visible to the support team only — never shown in this restaurant&apos;s own dashboard.
          </p>
          <textarea
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            placeholder="Add a note…"
            rows={2}
            className="input mb-2"
          />
          <button
            type="button"
            disabled={busy || !noteText.trim()}
            onClick={addNote}
            className="btn-secondary mb-3"
          >
            Add note
          </button>
          <div className="max-h-72 space-y-2 overflow-y-auto">
            {supportNotes.length === 0 && <p className="text-xs text-ink-faint">No notes yet.</p>}
            {supportNotes.map((n) => (
              <div key={n.id} className="rounded-lg border border-hairline/60 px-3 py-2 text-xs">
                <div className="mb-1 flex items-center justify-between text-ink-faint">
                  <span>
                    {n.authorFullName ?? "Unknown"} · {formatDateTime(n.createdAt)}
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => removeNote(n.id)}
                    className="hover:text-red-400"
                  >
                    Remove
                  </button>
                </div>
                <p className="whitespace-pre-wrap text-ink-secondary">{n.note}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Gap-audit P1 fix (Finding 2) — one staff member's row, expandable to show
 * their real active sessions (reads GET .../staff/[userId]/sessions) with
 * a per-session revoke (DELETE .../sessions/[sessionId]), replacing the
 * previous blind "revoke sessions" as the primary action. The bulk revoke
 * (onRevokeAll, unchanged) stays available for a "this account is
 * compromised, kill everything" sweep.
 */
function StaffSessionRow({
  restaurantId,
  userId,
  fullName,
  role,
  busy,
  onRevokeAll,
  onError,
}: {
  restaurantId: string;
  userId: string;
  fullName: string;
  role: string;
  busy: boolean;
  onRevokeAll: () => void;
  onError: (message: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [sessions, setSessions] = useState<ActiveSession[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  async function toggle() {
    const next = !expanded;
    setExpanded(next);
    if (next && sessions === null) {
      setLoading(true);
      try {
        const res = await apiGet<{ sessions: ActiveSession[] }>(
          `/api/admin/restaurants/${restaurantId}/staff/${userId}/sessions`,
        );
        setSessions(res.sessions);
      } catch (err) {
        onError(err instanceof ApiError ? err.message : "Could not load sessions.");
      } finally {
        setLoading(false);
      }
    }
  }

  async function revokeOne(sessionId: string) {
    setRevokingId(sessionId);
    try {
      await apiDelete(`/api/admin/restaurants/${restaurantId}/staff/${userId}/sessions/${sessionId}`);
      setSessions((prev) => (prev ? prev.filter((s) => s.id !== sessionId) : prev));
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Could not revoke that session.");
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <div className="rounded-lg border border-hairline/60 px-2.5 py-1.5 text-xs">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={toggle}
          className="text-left text-ink-secondary hover:text-ink"
        >
          <span aria-hidden className="mr-1 inline-block w-3 text-ink-faint">
            {expanded ? "▾" : "▸"}
          </span>
          {fullName} <span className="text-ink-faint">· {role}</span>
          {sessions !== null && (
            <span className="ml-1 text-ink-faint">
              ({sessions.length} active session{sessions.length === 1 ? "" : "s"})
            </span>
          )}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onRevokeAll}
          className="text-ink-muted underline decoration-dotted hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Revoke all
        </button>
      </div>
      {expanded && (
        <div className="mt-2 space-y-1.5 border-t border-hairline/60 pt-2">
          {loading && <p className="text-ink-faint">Loading sessions…</p>}
          {!loading && sessions && sessions.length === 0 && (
            <p className="text-ink-faint">No active sessions.</p>
          )}
          {!loading &&
            sessions?.map((s) => (
              <div key={s.id} className="flex items-center justify-between gap-2 rounded bg-surface-1 px-2 py-1.5">
                <div className="min-w-0">
                  <p className="truncate text-ink-secondary">{s.userAgent ?? "Unknown device"}</p>
                  <p className="text-ink-faint">
                    {s.ipAddress ?? "Unknown IP"} · Created {formatDateTime(s.createdAt)} · Expires{" "}
                    {formatDateTime(s.expiresAt)}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={revokingId === s.id}
                  onClick={() => revokeOne(s.id)}
                  className="shrink-0 text-ink-muted underline decoration-dotted hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {revokingId === s.id ? "Revoking…" : "Revoke"}
                </button>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
