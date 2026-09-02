"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPost, apiPatch, apiDelete, ApiError } from "@/lib/api-client";
import { LEAVE_TYPE_LABELS, LEAVE_STATUS_LABELS, leaveDayCount, type LeaveType, type LeaveStatus } from "@/lib/leave";
import { useDateSystem } from "@/lib/date-system";
import { formatDate } from "@/lib/nepali-date";
import { localDateIso } from "@/lib/local-date";

function base(slug: string) {
  return `/api/restaurants/${slug}`;
}

type LeaveRequest = {
  id: string;
  userId: string;
  fullName: string;
  branchId: string | null;
  leaveType: LeaveType;
  startDate: string;
  endDate: string;
  reason: string | null;
  status: LeaveStatus;
  reviewedAt: string | null;
  reviewNote: string | null;
  reviewedByName: string | null;
  createdAt: string;
};

type Holiday = {
  id: string;
  branchId: string | null;
  branchName: string | null;
  date: string;
  name: string;
};

type Branch = { id: string; name: string; isActive: boolean };

const LEAVE_STATUS_BADGE_CLASS: Record<LeaveStatus, string> = {
  pending: "bg-amber-500/15 text-amber-400",
  approved: "bg-green-500/15 text-green-400",
  rejected: "bg-red-500/15 text-red-400",
  cancelled: "bg-surface-1 text-ink-muted",
};

function LeaveStatusBadge({ status }: { status: LeaveStatus }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${LEAVE_STATUS_BADGE_CLASS[status]}`}>
      {LEAVE_STATUS_LABELS[status]}
    </span>
  );
}

/**
 * Phase 14 (Attendance overhaul, Track B) — staff leave requests + the
 * restaurant's declared holidays, in one tab (they're naturally read
 * together: a staff member picking leave dates wants to see what's
 * already a holiday). Reachable by the same audience as the Roster/
 * Attendance tabs — MANAGE_STAFF — which per StaffBoard's own comment
 * means a line-staff role without that permission can't reach this page
 * at all, so "request my own leave" is in practice only self-service for
 * owner/manager. That's an existing, disclosed limitation of the
 * Attendance overhaul's self-service surface (see AttendanceTab's "My
 * shift" card, same audience), not something this phase re-decides.
 */
export function LeaveTab({ slug, canManageStaff }: { slug: string; canManageStaff: boolean }) {
  const [requests, setRequests] = useState<LeaveRequest[]>([]);
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [canViewAll, setCanViewAll] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const dateSystem = useDateSystem();

  async function load() {
    try {
      const [requestsRes, holidaysRes, branchesRes] = await Promise.all([
        apiGet<{ requests: LeaveRequest[]; canViewAll: boolean }>(`${base(slug)}/leave-requests`),
        apiGet<{ holidays: Holiday[] }>(`${base(slug)}/holidays`),
        apiGet<{ branches: Branch[] }>(`${base(slug)}/branches`),
      ]);
      setRequests(requestsRes.requests);
      setCanViewAll(requestsRes.canViewAll);
      setHolidays(holidaysRes.holidays);
      setBranches(branchesRes.branches);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load leave data.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  if (loading) return <p className="text-sm text-ink-muted">Loading leave…</p>;

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-400">{error}</p>}

      <RequestLeaveForm slug={slug} onCreated={load} />

      <LeaveRequestsTable slug={slug} requests={requests} canViewAll={canViewAll} onChanged={load} dateSystem={dateSystem} />

      <HolidaysCard
        slug={slug}
        holidays={holidays}
        branches={branches}
        canManage={canManageStaff}
        onChanged={load}
        dateSystem={dateSystem}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Request leave
// ---------------------------------------------------------------------------

function RequestLeaveForm({ slug, onCreated }: { slug: string; onCreated: () => void }) {
  const today = localDateIso();
  const [leaveType, setLeaveType] = useState<LeaveType>("casual");
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/leave-requests`, {
        leaveType,
        startDate,
        endDate,
        reason: reason || undefined,
      });
      setReason("");
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not submit this leave request.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-hairline bg-surface-2 p-4">
      <p className="mb-2 text-sm font-semibold text-ink">Request leave</p>
      {error && <p className="mb-2 text-sm text-red-400">{error}</p>}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end">
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-secondary">Type</label>
          <select value={leaveType} onChange={(e) => setLeaveType(e.target.value as LeaveType)} className="input">
            {(Object.keys(LEAVE_TYPE_LABELS) as LeaveType[]).map((t) => (
              <option key={t} value={t}>
                {LEAVE_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-secondary">From</label>
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="input" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-secondary">To</label>
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="input" />
        </div>
        <div className="flex-1 sm:min-w-[200px]">
          <label className="mb-1 block text-xs font-medium text-ink-secondary">Reason (optional)</label>
          <input value={reason} onChange={(e) => setReason(e.target.value)} className="input w-full" />
        </div>
        <button disabled={busy} onClick={submit} className="btn-primary">
          {busy ? "Submitting…" : "Submit request"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Leave requests table
// ---------------------------------------------------------------------------

function LeaveRequestsTable({
  slug,
  requests,
  canViewAll,
  onChanged,
  dateSystem,
}: {
  slug: string;
  requests: LeaveRequest[];
  canViewAll: boolean;
  onChanged: () => void;
  dateSystem: ReturnType<typeof useDateSystem>;
}) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-hairline bg-surface-2">
      <table className="w-full text-sm">
        <thead className="bg-surface-1 text-left text-xs uppercase tracking-wide text-ink-muted">
          <tr>
            {canViewAll && <th className="px-3 py-2">Staff</th>}
            <th className="px-3 py-2">Type</th>
            <th className="px-3 py-2">Dates</th>
            <th className="px-3 py-2">Days</th>
            <th className="px-3 py-2">Reason</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {requests.length === 0 && (
            <tr>
              <td colSpan={canViewAll ? 7 : 6} className="px-3 py-6 text-center text-ink-faint">
                No leave requests yet.
              </td>
            </tr>
          )}
          {requests.map((r) => (
            <LeaveRequestRow
              key={r.id}
              slug={slug}
              request={r}
              canViewAll={canViewAll}
              onChanged={onChanged}
              dateSystem={dateSystem}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LeaveRequestRow({
  slug,
  request: r,
  canViewAll,
  onChanged,
  dateSystem,
}: {
  slug: string;
  request: LeaveRequest;
  canViewAll: boolean;
  onChanged: () => void;
  dateSystem: ReturnType<typeof useDateSystem>;
}) {
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectNote, setRejectNote] = useState("");

  async function cancel() {
    setBusy(true);
    try {
      await apiPatch(`${base(slug)}/leave-requests/${r.id}`, {});
      onChanged();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not cancel this request.");
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    setBusy(true);
    try {
      await apiPatch(`${base(slug)}/leave-requests/${r.id}/status`, { status: "approved" });
      onChanged();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not approve this request.");
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    if (!rejectNote.trim()) return;
    setBusy(true);
    try {
      await apiPatch(`${base(slug)}/leave-requests/${r.id}/status`, { status: "rejected", reviewNote: rejectNote });
      setRejecting(false);
      setRejectNote("");
      onChanged();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not reject this request.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr className="border-t border-hairline/60">
      {canViewAll && <td className="px-3 py-2 font-medium text-ink">{r.fullName}</td>}
      <td className="px-3 py-2">{LEAVE_TYPE_LABELS[r.leaveType]}</td>
      <td className="px-3 py-2 text-ink-muted">
        {formatDate(r.startDate, dateSystem)}
        {r.startDate !== r.endDate && <> — {formatDate(r.endDate, dateSystem)}</>}
      </td>
      <td className="px-3 py-2 text-ink-muted">{leaveDayCount(r.startDate, r.endDate)}</td>
      <td className="px-3 py-2 text-ink-muted">{r.reason || "—"}</td>
      <td className="px-3 py-2">
        <LeaveStatusBadge status={r.status} />
        {r.status !== "pending" && r.reviewNote && (
          <p className="mt-1 text-xs text-ink-faint">{r.reviewNote}</p>
        )}
      </td>
      <td className="px-3 py-2">
        {r.status === "pending" && !canViewAll && (
          <button disabled={busy} onClick={cancel} className="text-xs text-ink-muted underline hover:text-ink">
            Cancel
          </button>
        )}
        {r.status === "pending" && canViewAll && !rejecting && (
          <div className="flex gap-2 text-xs">
            <button disabled={busy} onClick={approve} className="text-green-400 underline hover:text-green-200">
              Approve
            </button>
            <button disabled={busy} onClick={() => setRejecting(true)} className="text-red-400 underline hover:text-red-200">
              Reject
            </button>
          </div>
        )}
        {r.status === "pending" && canViewAll && rejecting && (
          <div className="flex flex-col gap-1">
            <input
              value={rejectNote}
              onChange={(e) => setRejectNote(e.target.value)}
              placeholder="Reason for rejecting (required)"
              className="input text-xs"
            />
            <div className="flex gap-2 text-xs">
              <button disabled={busy || !rejectNote.trim()} onClick={reject} className="text-red-400 underline hover:text-red-200">
                Confirm reject
              </button>
              <button
                disabled={busy}
                onClick={() => {
                  setRejecting(false);
                  setRejectNote("");
                }}
                className="text-ink-muted underline hover:text-ink"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Holidays
// ---------------------------------------------------------------------------

function HolidaysCard({
  slug,
  holidays,
  branches,
  canManage,
  onChanged,
  dateSystem,
}: {
  slug: string;
  holidays: Holiday[];
  branches: Branch[];
  canManage: boolean;
  onChanged: () => void;
  dateSystem: ReturnType<typeof useDateSystem>;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [date, setDate] = useState(localDateIso());
  const [name, setName] = useState("");
  const [branchId, setBranchId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function submit() {
    if (!name.trim()) {
      setError("A name is required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/holidays`, { date, name, branchId: branchId || null });
      setName("");
      setShowAdd(false);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add this holiday.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setDeletingId(id);
    try {
      await apiDelete(`${base(slug)}/holidays/${id}`);
      onChanged();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not remove this holiday.");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="rounded-2xl border border-hairline bg-surface-2 p-4">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-semibold text-ink">Holidays</p>
        {canManage && (
          <button onClick={() => setShowAdd((v) => !v)} className="btn-secondary text-xs">
            {showAdd ? "Cancel" : "+ Add holiday"}
          </button>
        )}
      </div>

      {showAdd && (
        <div className="mb-3 flex flex-col gap-2 rounded-xl bg-surface-1 p-3 sm:flex-row sm:flex-wrap sm:items-end">
          {error && <p className="w-full text-sm text-red-400">{error}</p>}
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-secondary">Date</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="input" />
          </div>
          <div className="flex-1 sm:min-w-[160px]">
            <label className="mb-1 block text-xs font-medium text-ink-secondary">Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Dashain" className="input w-full" />
          </div>
          {branches.length > 1 && (
            <div>
              <label className="mb-1 block text-xs font-medium text-ink-secondary">Branch</label>
              <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className="input">
                <option value="">All branches</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <button disabled={busy} onClick={submit} className="btn-primary">
            {busy ? "Adding…" : "Add"}
          </button>
        </div>
      )}

      {holidays.length === 0 ? (
        <p className="text-xs text-ink-faint">No holidays recorded yet.</p>
      ) : (
        <ul className="divide-y divide-hairline/60">
          {holidays.map((h) => (
            <li key={h.id} className="flex items-center justify-between py-2 text-sm">
              <div>
                <span className="font-medium text-ink">{formatDate(h.date, dateSystem)}</span>
                <span className="ml-2 text-ink-secondary">{h.name}</span>
                {h.branchName && <span className="ml-2 text-xs text-ink-faint">({h.branchName})</span>}
              </div>
              {canManage && (
                <button
                  disabled={deletingId === h.id}
                  onClick={() => remove(h.id)}
                  className="text-xs text-ink-faint underline hover:text-red-400"
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
