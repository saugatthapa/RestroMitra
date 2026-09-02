"use client";

import { useEffect, useMemo, useState } from "react";
import { apiGet, apiPost, apiDelete, ApiError } from "@/lib/api-client";
import { SCHEDULE_STATUS_LABELS, type ScheduleStatus, type ScheduleVariance } from "@/lib/scheduling";
import { useDateSystem } from "@/lib/date-system";
import { formatDate } from "@/lib/nepali-date";
import { localDateIso } from "@/lib/local-date";

function base(slug: string) {
  return `/api/restaurants/${slug}`;
}

type StaffMember = { id: string; userId: string; fullName: string; isActive: boolean };
type Branch = { id: string; name: string; isActive: boolean };

type ScheduledShift = {
  id: string;
  userId: string;
  fullName: string;
  branchId: string | null;
  branchName: string | null;
  shiftDate: string;
  plannedStartAt: string;
  plannedEndAt: string;
  note: string | null;
  variance: ScheduleVariance;
};

const STATUS_BADGE_CLASS: Record<ScheduleStatus, string> = {
  upcoming: "bg-surface-1 text-ink-secondary",
  in_progress: "bg-blue-500/15 text-blue-400",
  completed: "bg-green-500/15 text-green-400",
  no_show: "bg-red-500/15 text-red-400",
};

function formatTimeRange(startIso: string, endIso: string) {
  const opts: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
  const start = new Date(startIso).toLocaleTimeString("en-NP", opts);
  const end = new Date(endIso).toLocaleTimeString("en-NP", opts);
  return `${start} – ${end}`;
}

function VarianceBadge({ variance }: { variance: ScheduleVariance }) {
  const notes: string[] = [];
  if (variance.lateMinutes > 0) notes.push(`${variance.lateMinutes}m late`);
  if (variance.earlyDepartureMinutes > 0) notes.push(`left ${variance.earlyDepartureMinutes}m early`);
  return (
    <div>
      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE_CLASS[variance.status]}`}>
        {SCHEDULE_STATUS_LABELS[variance.status]}
      </span>
      {notes.length > 0 && <p className="mt-1 text-xs text-amber-400">{notes.join(", ")}</p>}
    </div>
  );
}

/**
 * Phase 15 (Attendance overhaul, Track B — Scheduling) — the planned
 * roster for a week, matched against actual clock-in/out to surface
 * late/early/no-show at a glance. Same MANAGE_STAFF-gated audience as the
 * Roster/Attendance/Leave tabs (see LeaveTab's own comment on that
 * disclosed limitation).
 */
export function ScheduleTab({ slug, canManageStaff }: { slug: string; canManageStaff: boolean }) {
  const [shifts, setShifts] = useState<ScheduledShift[]>([]);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [canViewAll, setCanViewAll] = useState(false);
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const dateSystem = useDateSystem();

  async function load(range?: { from: string; to: string }) {
    try {
      const qs = range ? `?from=${range.from}&to=${range.to}` : "";
      // GET /staff requires MANAGE_STAFF — safe to always call unconditionally
      // here because StaffBoard only renders this tab at all when
      // canManageStaff is true (same tab-visibility rule as Attendance/Leave).
      const [scheduleRes, staffRes, branchesRes] = await Promise.all([
        apiGet<{ shifts: ScheduledShift[]; canViewAll: boolean; from: string; to: string }>(
          `${base(slug)}/schedule${qs}`,
        ),
        apiGet<{ staff: StaffMember[] }>(`${base(slug)}/staff`),
        apiGet<{ branches: Branch[] }>(`${base(slug)}/branches`),
      ]);
      setShifts(scheduleRes.shifts);
      setCanViewAll(scheduleRes.canViewAll);
      setFrom(scheduleRes.from);
      setTo(scheduleRes.to);
      setStaff(staffRes.staff.filter((s) => s.isActive));
      setBranches(branchesRes.branches);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load the schedule.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  function shiftWeek(days: number) {
    if (!from) return;
    const next = new Date(`${from}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + days);
    const nextFrom = next.toISOString().slice(0, 10);
    const nextTo = new Date(next.getTime() + 6 * 86_400_000).toISOString().slice(0, 10);
    setLoading(true);
    load({ from: nextFrom, to: nextTo });
  }

  const grouped = useMemo(() => {
    const byDate = new Map<string, ScheduledShift[]>();
    for (const s of shifts) {
      const bucket = byDate.get(s.shiftDate);
      if (bucket) bucket.push(s);
      else byDate.set(s.shiftDate, [s]);
    }
    return [...byDate.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  }, [shifts]);

  if (loading) return <p className="text-sm text-ink-muted">Loading schedule…</p>;

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-400">{error}</p>}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm text-ink-secondary">
          <button onClick={() => shiftWeek(-7)} className="btn-secondary text-xs">
            ← Previous week
          </button>
          <span className="font-medium text-ink">
            {from && formatDate(from, dateSystem)} – {to && formatDate(to, dateSystem)}
          </span>
          <button onClick={() => shiftWeek(7)} className="btn-secondary text-xs">
            Next week →
          </button>
        </div>
        {canManageStaff && (
          <button onClick={() => setShowAdd((v) => !v)} className="btn-primary text-xs">
            {showAdd ? "Cancel" : "+ Add shift"}
          </button>
        )}
      </div>

      {showAdd && canManageStaff && (
        <AddShiftForm
          slug={slug}
          staff={staff}
          branches={branches}
          onCreated={() => {
            setShowAdd(false);
            load(from && to ? { from, to } : undefined);
          }}
        />
      )}

      {grouped.length === 0 ? (
        <p className="rounded-2xl border border-hairline bg-surface-2 p-4 text-sm text-ink-faint">
          No shifts scheduled for this week.
        </p>
      ) : (
        <div className="space-y-3">
          {grouped.map(([date, dayShifts]) => (
            <div key={date} className="overflow-x-auto rounded-2xl border border-hairline bg-surface-2">
              <p className="border-b border-hairline/60 px-3 py-2 text-sm font-semibold text-ink">
                {formatDate(date, dateSystem)}
              </p>
              <table className="w-full text-sm">
                <thead className="bg-surface-1 text-left text-xs uppercase tracking-wide text-ink-muted">
                  <tr>
                    {canViewAll && <th className="px-3 py-2">Staff</th>}
                    <th className="px-3 py-2">Time</th>
                    {branches.length > 1 && <th className="px-3 py-2">Branch</th>}
                    <th className="px-3 py-2">Note</th>
                    <th className="px-3 py-2">Status</th>
                    {canManageStaff && <th className="px-3 py-2"></th>}
                  </tr>
                </thead>
                <tbody>
                  {dayShifts.map((s) => (
                    <ShiftRow
                      key={s.id}
                      slug={slug}
                      shift={s}
                      canViewAll={canViewAll}
                      canManageStaff={canManageStaff}
                      showBranchColumn={branches.length > 1}
                      onChanged={() => load(from && to ? { from, to } : undefined)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ShiftRow({
  slug,
  shift: s,
  canViewAll,
  canManageStaff,
  showBranchColumn,
  onChanged,
}: {
  slug: string;
  shift: ScheduledShift;
  canViewAll: boolean;
  canManageStaff: boolean;
  showBranchColumn: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function remove() {
    if (!confirm("Remove this scheduled shift?")) return;
    setBusy(true);
    try {
      await apiDelete(`${base(slug)}/schedule/${s.id}`);
      onChanged();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not remove this shift.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr className="border-t border-hairline/60">
      {canViewAll && <td className="px-3 py-2 font-medium text-ink">{s.fullName}</td>}
      <td className="px-3 py-2 text-ink-secondary">{formatTimeRange(s.plannedStartAt, s.plannedEndAt)}</td>
      {showBranchColumn && <td className="px-3 py-2 text-ink-muted">{s.branchName ?? "All branches"}</td>}
      <td className="px-3 py-2 text-ink-muted">{s.note || "—"}</td>
      <td className="px-3 py-2">
        <VarianceBadge variance={s.variance} />
      </td>
      {canManageStaff && (
        <td className="px-3 py-2">
          <button disabled={busy} onClick={remove} className="text-xs text-ink-faint underline hover:text-red-400">
            Remove
          </button>
        </td>
      )}
    </tr>
  );
}

function AddShiftForm({
  slug,
  staff,
  branches,
  onCreated,
}: {
  slug: string;
  staff: StaffMember[];
  branches: Branch[];
  onCreated: () => void;
}) {
  const [userId, setUserId] = useState(staff[0]?.userId ?? "");
  const [shiftDate, setShiftDate] = useState(localDateIso());
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("17:00");
  const [branchId, setBranchId] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!userId) {
      setError("Choose a staff member.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/schedule`, {
        userId,
        branchId: branchId || null,
        shiftDate,
        startTime,
        endTime,
        note: note || undefined,
      });
      setNote("");
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add this shift.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-hairline bg-surface-2 p-4">
      {error && <p className="mb-2 text-sm text-red-400">{error}</p>}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end">
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-secondary">Staff</label>
          <select value={userId} onChange={(e) => setUserId(e.target.value)} className="input">
            {staff.map((s) => (
              <option key={s.userId} value={s.userId}>
                {s.fullName}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-secondary">Date</label>
          <input type="date" value={shiftDate} onChange={(e) => setShiftDate(e.target.value)} className="input" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-secondary">Start</label>
          <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className="input" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-secondary">End</label>
          <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className="input" />
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
        <div className="flex-1 sm:min-w-[160px]">
          <label className="mb-1 block text-xs font-medium text-ink-secondary">Note (optional)</label>
          <input value={note} onChange={(e) => setNote(e.target.value)} className="input w-full" />
        </div>
        <button disabled={busy} onClick={submit} className="btn-primary">
          {busy ? "Adding…" : "Add shift"}
        </button>
      </div>
    </div>
  );
}
