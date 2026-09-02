"use client";

import { useState } from "react";
import { apiGet, apiPatch, ApiError } from "@/lib/api-client";
import { formatDate } from "@/lib/nepali-date";
import { useDateSystem } from "@/lib/date-system";

// Same ISO <-> <input type="datetime-local"> conversion already used by
// ReservationsBoard.tsx's edit form — a datetime-local input's value is
// always in the BROWSER's local time, never UTC, so a naive .slice(0, 16)
// on an ISO string would silently show the wrong time whenever the
// browser's local timezone isn't UTC+0.
function toDatetimeLocal(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

type AttendanceStatus = "needs_review" | "verified" | "rejected";

type Record_ = {
  id: string;
  fullName: string;
  clockInAt: string;
  clockOutAt: string | null;
  note: string | null;
  hasClockInPhoto: boolean;
  hasClockOutPhoto: boolean;
  // P2 gap-audit fix — the separate workplace/surroundings photo.
  hasClockInWorkplacePhoto: boolean;
  hasClockOutWorkplacePhoto: boolean;
  status: AttendanceStatus;
  reviewNote: string | null;
};

const STATUS_LABELS: Record<AttendanceStatus, string> = {
  needs_review: "Needs review",
  verified: "Verified",
  rejected: "Rejected",
};

/**
 * Phase 13 (Attendance overhaul, Track B) — the owner/manager review
 * screen for one shift: view its captured selfie(s) and record a
 * verified/rejected/needs-review call, plus a separate "correct the
 * times" form for fixing a wrong clock-in/out (always with a required
 * reason — see correctAttendanceRecordSchema's own comment).
 */
export function AttendanceReviewModal({
  slug,
  record,
  onUpdated,
  onClose,
}: {
  slug: string;
  record: Record_;
  onUpdated: () => void;
  onClose: () => void;
}) {
  const base = `/api/restaurants/${slug}`;
  const dateSystem = useDateSystem();

  const [mode, setMode] = useState<"review" | "correct">("review");

  const [status, setStatus] = useState<AttendanceStatus>(record.status);
  const [reviewNote, setReviewNote] = useState(record.reviewNote ?? "");
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [photoLoadingKind, setPhotoLoadingKind] = useState<
    "clock_in" | "clock_out" | "clock_in_workplace" | "clock_out_workplace" | null
  >(null);

  const [clockInAt, setClockInAt] = useState(toDatetimeLocal(record.clockInAt));
  const [clockOutAt, setClockOutAt] = useState(record.clockOutAt ? toDatetimeLocal(record.clockOutAt) : "");
  const [note, setNote] = useState(record.note ?? "");
  const [reason, setReason] = useState("");
  const [correctBusy, setCorrectBusy] = useState(false);
  const [correctError, setCorrectError] = useState<string | null>(null);

  async function viewPhoto(kind: "clock_in" | "clock_out" | "clock_in_workplace" | "clock_out_workplace") {
    setPhotoLoadingKind(kind);
    try {
      const res = await apiGet<{ url: string }>(`${base}/attendance/${record.id}/photo?kind=${kind}`);
      window.open(res.url, "_blank", "noopener,noreferrer");
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not open that photo.");
    } finally {
      setPhotoLoadingKind(null);
    }
  }

  async function submitReview() {
    setReviewBusy(true);
    setReviewError(null);
    try {
      await apiPatch(`${base}/attendance/${record.id}/status`, { status, reviewNote: reviewNote || undefined });
      onUpdated();
      onClose();
    } catch (err) {
      setReviewError(err instanceof ApiError ? err.message : "Could not save this review.");
    } finally {
      setReviewBusy(false);
    }
  }

  async function submitCorrection() {
    if (!reason.trim()) {
      setCorrectError("A reason is required for any correction.");
      return;
    }
    setCorrectBusy(true);
    setCorrectError(null);
    try {
      await apiPatch(`${base}/attendance/${record.id}`, {
        clockInAt: new Date(clockInAt).toISOString(),
        clockOutAt: clockOutAt ? new Date(clockOutAt).toISOString() : undefined,
        note: note || undefined,
        reason,
      });
      onUpdated();
      onClose();
    } catch (err) {
      setCorrectError(err instanceof ApiError ? err.message : "Could not save this correction.");
    } finally {
      setCorrectBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-neutral-900">{record.fullName}&apos;s shift</h3>
          <button type="button" onClick={onClose} className="text-sm text-neutral-400 hover:text-neutral-600">
            Close
          </button>
        </div>

        <p className="mb-3 text-xs text-neutral-500">
          {formatDate(record.clockInAt, dateSystem, { withTime: true })} —{" "}
          {record.clockOutAt ? formatDate(record.clockOutAt, dateSystem, { withTime: true }) : "still clocked in"}
        </p>

        <div className="mb-4 flex gap-2 border-b border-neutral-200">
          <button
            type="button"
            onClick={() => setMode("review")}
            className={`-mb-px border-b-2 px-2 py-1.5 text-sm font-medium ${
              mode === "review" ? "border-orange-600 text-orange-700" : "border-transparent text-neutral-500"
            }`}
          >
            Review
          </button>
          <button
            type="button"
            onClick={() => setMode("correct")}
            className={`-mb-px border-b-2 px-2 py-1.5 text-sm font-medium ${
              mode === "correct" ? "border-orange-600 text-orange-700" : "border-transparent text-neutral-500"
            }`}
          >
            Correct times
          </button>
        </div>

        {mode === "review" && (
          <div>
            <div className="mb-3 flex flex-wrap gap-2">
              {record.hasClockInPhoto && (
                <button
                  type="button"
                  disabled={photoLoadingKind === "clock_in"}
                  onClick={() => viewPhoto("clock_in")}
                  className="btn-secondary text-xs"
                >
                  View clock-in selfie
                </button>
              )}
              {record.hasClockOutPhoto && (
                <button
                  type="button"
                  disabled={photoLoadingKind === "clock_out"}
                  onClick={() => viewPhoto("clock_out")}
                  className="btn-secondary text-xs"
                >
                  View clock-out selfie
                </button>
              )}
              {/* P2 gap-audit fix — the separate workplace/surroundings
                  photo, clearly labeled "workplace" so a reviewer never
                  confuses it for the identity-proving selfie above. */}
              {record.hasClockInWorkplacePhoto && (
                <button
                  type="button"
                  disabled={photoLoadingKind === "clock_in_workplace"}
                  onClick={() => viewPhoto("clock_in_workplace")}
                  className="btn-secondary text-xs"
                >
                  View clock-in workplace photo
                </button>
              )}
              {record.hasClockOutWorkplacePhoto && (
                <button
                  type="button"
                  disabled={photoLoadingKind === "clock_out_workplace"}
                  onClick={() => viewPhoto("clock_out_workplace")}
                  className="btn-secondary text-xs"
                >
                  View clock-out workplace photo
                </button>
              )}
              {!record.hasClockInPhoto &&
                !record.hasClockOutPhoto &&
                !record.hasClockInWorkplacePhoto &&
                !record.hasClockOutWorkplacePhoto && (
                  <p className="text-xs text-neutral-400">No photo was captured for this shift.</p>
                )}
            </div>

            <label className="mb-2 block text-xs font-medium text-neutral-600">Status</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as AttendanceStatus)}
              className="input mb-2"
            >
              {(Object.keys(STATUS_LABELS) as AttendanceStatus[]).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
            <textarea
              value={reviewNote}
              onChange={(e) => setReviewNote(e.target.value)}
              placeholder={status === "rejected" ? "Required: why is this rejected?" : "Optional note"}
              rows={2}
              className="input mb-2"
            />
            {reviewError && <p className="mb-2 text-sm text-red-600">{reviewError}</p>}
            <button type="button" disabled={reviewBusy} onClick={submitReview} className="btn-primary w-full">
              {reviewBusy ? "Saving…" : "Save review"}
            </button>
          </div>
        )}

        {mode === "correct" && (
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-600">Clock in</label>
            <input
              type="datetime-local"
              value={clockInAt}
              onChange={(e) => setClockInAt(e.target.value)}
              className="input mb-2"
            />
            <label className="mb-1 block text-xs font-medium text-neutral-600">Clock out</label>
            <input
              type="datetime-local"
              value={clockOutAt}
              onChange={(e) => setClockOutAt(e.target.value)}
              className="input mb-2"
            />
            <label className="mb-1 block text-xs font-medium text-neutral-600">Note</label>
            <input value={note} onChange={(e) => setNote(e.target.value)} className="input mb-2" />
            <label className="mb-1 block text-xs font-medium text-neutral-600">
              Reason for this correction (required)
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Forgot to clock out — confirmed with staff member"
              rows={2}
              className="input mb-2"
            />
            {correctError && <p className="mb-2 text-sm text-red-600">{correctError}</p>}
            <button type="button" disabled={correctBusy} onClick={submitCorrection} className="btn-primary w-full">
              {correctBusy ? "Saving…" : "Save correction"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
