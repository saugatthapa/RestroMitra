"use client";

import { useState } from "react";
import { apiPost, apiDelete, ApiError } from "@/lib/api-client";
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
  healthy: "bg-emerald-50 text-emerald-700 border-emerald-200",
  watch: "bg-amber-50 text-amber-700 border-amber-200",
  at_risk: "bg-red-50 text-red-700 border-red-200",
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
    <div className="mt-6 rounded-xl border border-neutral-200 bg-white p-4">
      <h2 className="mb-3 text-sm font-semibold text-neutral-900">Support</h2>
      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
      {revokedMessage && <p className="mb-3 text-sm text-emerald-700">{revokedMessage}</p>}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div>
          <div className="mb-4">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
              Health score
            </h3>
            <div className="flex items-center gap-3">
              <span className="text-2xl font-semibold tabular-nums text-neutral-900">
                {healthScore.score}
              </span>
              <span
                className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${BAND_CLASSES[healthScore.band]}`}
              >
                {HEALTH_BAND_LABELS[healthScore.band]}
              </span>
            </div>
            {healthScore.reasons.length > 0 ? (
              <ul className="mt-2 space-y-1 text-xs text-neutral-600">
                {healthScore.reasons.map((r, i) => (
                  <li key={i}>
                    {r.label} <span className="text-neutral-400">({r.delta})</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-xs text-neutral-500">No issues found.</p>
            )}
          </div>

          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
              Status tags
            </h3>
            <div className="mb-2 flex flex-wrap gap-1.5">
              {supportTags.length === 0 && <p className="text-xs text-neutral-400">No tags.</p>}
              {supportTags.map((t) => (
                <span
                  key={t.id}
                  className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-700"
                >
                  {SUPPORT_TAG_LABELS[t.tag]}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => removeTag(t.id)}
                    className="text-neutral-400 hover:text-red-600"
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
                    className="rounded-full border border-neutral-200 px-2.5 py-1 text-xs text-neutral-600 transition hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    + {SUPPORT_TAG_LABELS[t]}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="mt-4">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
              Staff sessions
            </h3>
            <div className="space-y-1.5">
              {staff.length === 0 && <p className="text-xs text-neutral-400">No active staff.</p>}
              {staff.map((s) => (
                <div
                  key={s.userRoleId}
                  className="flex items-center justify-between rounded-lg border border-neutral-100 px-2.5 py-1.5 text-xs"
                >
                  <span className="text-neutral-700">
                    {s.fullName} <span className="text-neutral-400">· {s.role}</span>
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => revokeSessions(s.userId, s.fullName)}
                    className="text-neutral-500 underline decoration-dotted hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Revoke sessions
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Internal notes
          </h3>
          <p className="mb-2 text-xs text-neutral-400">
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
            {supportNotes.length === 0 && <p className="text-xs text-neutral-400">No notes yet.</p>}
            {supportNotes.map((n) => (
              <div key={n.id} className="rounded-lg border border-neutral-100 px-3 py-2 text-xs">
                <div className="mb-1 flex items-center justify-between text-neutral-400">
                  <span>
                    {n.authorFullName ?? "Unknown"} · {formatDateTime(n.createdAt)}
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => removeNote(n.id)}
                    className="hover:text-red-600"
                  >
                    Remove
                  </button>
                </div>
                <p className="whitespace-pre-wrap text-neutral-700">{n.note}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
