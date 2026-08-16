"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPost, apiPatch, ApiError } from "@/lib/api-client";
import { ASSIGNABLE_STAFF_ROLES, STAFF_ROLE_LABELS, type AssignableStaffRole } from "@/lib/staff-roles";
import { computeDurationMinutes, formatDuration } from "@/lib/attendance";

type StaffMember = {
  id: string; // user_roles id
  userId: string;
  fullName: string;
  phone: string;
  role: string;
  isActive: boolean;
  createdAt: string;
  branchId: string | null;
  branchName: string | null;
};

type Branch = { id: string; name: string; isActive: boolean };

type AttendanceRecord = {
  id: string;
  userId: string;
  fullName: string;
  clockInAt: string;
  clockOutAt: string | null;
  note: string | null;
};

function base(slug: string) {
  return `/api/restaurants/${slug}`;
}

const TABS = ["Roster", "Attendance"] as const;
type Tab = (typeof TABS)[number];

export function StaffBoard({ slug, canManageStaff }: { slug: string; canManageStaff: boolean }) {
  const [tab, setTab] = useState<Tab>("Roster");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 border-b border-neutral-200">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
              tab === t
                ? "border-orange-600 text-orange-700"
                : "border-transparent text-neutral-500 hover:text-neutral-800"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "Roster" && <RosterTab slug={slug} canManageStaff={canManageStaff} />}
      {tab === "Attendance" && <AttendanceTab slug={slug} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Roster tab
// ---------------------------------------------------------------------------

function RosterTab({ slug, canManageStaff }: { slug: string; canManageStaff: boolean }) {
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  async function load() {
    try {
      const [staffRes, branchesRes] = await Promise.all([
        apiGet<{ staff: StaffMember[] }>(`${base(slug)}/staff`),
        apiGet<{ branches: Branch[] }>(`${base(slug)}/branches`),
      ]);
      setStaff(staffRes.staff);
      setBranches(branchesRes.branches);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load staff.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  if (!canManageStaff) {
    return <p className="text-sm text-neutral-400">Your role doesn&apos;t have access to the staff roster.</p>;
  }

  if (loading) return <p className="text-sm text-neutral-500">Loading staff…</p>;

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="flex justify-end">
        <button onClick={() => setShowAdd((v) => !v)} className="btn-primary">
          {showAdd ? "Cancel" : "+ Add staff"}
        </button>
      </div>

      {showAdd && (
        <AddStaffForm
          slug={slug}
          branches={branches}
          onAdded={() => {
            setShowAdd(false);
            load();
          }}
        />
      )}

      <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Phone</th>
              <th className="px-3 py-2">Role</th>
              {branches.length > 1 && <th className="px-3 py-2">Branch</th>}
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {staff.map((s) => (
              <StaffRow
                key={s.id}
                slug={slug}
                member={s}
                branches={branches}
                onChanged={load}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StaffRow({
  slug,
  member,
  branches,
  onChanged,
}: {
  slug: string;
  member: StaffMember;
  branches: Branch[];
  onChanged: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const editable = member.role !== "owner" && member.role !== "platform_admin";

  async function changeRole(role: AssignableStaffRole) {
    setSaving(true);
    try {
      await apiPatch(`${base(slug)}/staff/${member.id}`, { role });
      onChanged();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not change role.");
    } finally {
      setSaving(false);
    }
  }

  async function changeBranch(branchId: string) {
    setSaving(true);
    try {
      await apiPatch(`${base(slug)}/staff/${member.id}`, { branchId: branchId || null });
      onChanged();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not change branch.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive() {
    setSaving(true);
    try {
      await apiPatch(`${base(slug)}/staff/${member.id}`, { isActive: !member.isActive });
      onChanged();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not update status.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <tr className="border-t border-neutral-100">
      <td className="px-3 py-2 font-medium text-neutral-900">{member.fullName}</td>
      <td className="px-3 py-2 text-neutral-500">{member.phone}</td>
      <td className="px-3 py-2">
        {editable ? (
          <select
            value={member.role}
            disabled={saving}
            onChange={(e) => changeRole(e.target.value as AssignableStaffRole)}
            className="input !w-auto"
          >
            {ASSIGNABLE_STAFF_ROLES.map((r) => (
              <option key={r} value={r}>
                {STAFF_ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        ) : (
          <span className="capitalize text-neutral-700">{member.role.replace("_", " ")}</span>
        )}
      </td>
      {branches.length > 1 && (
        <td className="px-3 py-2">
          {editable ? (
            <select
              value={member.branchId ?? ""}
              disabled={saving}
              onChange={(e) => changeBranch(e.target.value)}
              className="input !w-auto"
            >
              <option value="">All branches</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-neutral-500">{member.branchName ?? "All branches"}</span>
          )}
        </td>
      )}
      <td className="px-3 py-2">
        {member.isActive ? (
          <span className="text-green-700">Active</span>
        ) : (
          <span className="text-neutral-400">Inactive</span>
        )}
      </td>
      <td className="px-3 py-2 text-right">
        {editable && (
          <button
            disabled={saving}
            onClick={toggleActive}
            className="text-xs font-medium text-orange-700 hover:underline"
          >
            {member.isActive ? "Deactivate" : "Reactivate"}
          </button>
        )}
      </td>
    </tr>
  );
}

function AddStaffForm({
  slug,
  branches,
  onAdded,
}: {
  slug: string;
  branches: Branch[];
  onAdded: () => void;
}) {
  const [phone, setPhone] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<AssignableStaffRole>("waiter");
  const [branchId, setBranchId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/staff`, {
        phone,
        fullName: fullName || undefined,
        password: password || undefined,
        role,
        branchId: branchId || undefined,
      });
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add staff member.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded-2xl border border-neutral-200 bg-white p-4">
      {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Phone</span>
          <input
            required
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="input"
            placeholder="98XXXXXXXX"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Role</span>
          <select value={role} onChange={(e) => setRole(e.target.value as AssignableStaffRole)} className="input">
            {ASSIGNABLE_STAFF_ROLES.map((r) => (
              <option key={r} value={r}>
                {STAFF_ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </label>
        {branches.length > 1 && (
          <label className="text-sm">
            <span className="mb-1 block text-neutral-600">Branch</span>
            <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className="input">
              <option value="">All branches</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Full name (new accounts only)</span>
          <input value={fullName} onChange={(e) => setFullName(e.target.value)} className="input" />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Password (new accounts only)</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="input"
          />
        </label>
      </div>
      <p className="mt-2 text-xs text-neutral-400">
        If this phone number already has a DhankiPOS account, they&apos;re just granted a role here —
        name and password are ignored. Otherwise a new account is created with the name and password
        above.
      </p>
      <button disabled={saving} className="btn-primary mt-3">
        {saving ? "Adding…" : "Add staff member"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Attendance tab
// ---------------------------------------------------------------------------

function AttendanceTab({ slug }: { slug: string }) {
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [canViewAll, setCanViewAll] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  async function load() {
    try {
      const res = await apiGet<{ records: AttendanceRecord[]; canViewAll: boolean }>(
        `${base(slug)}/attendance`,
      );
      setRecords(res.records);
      setCanViewAll(res.canViewAll);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load attendance.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  // No client-side "am I currently clocked in?" guess: when canViewAll is
  // true, `records` includes every staff member's shifts, so the first
  // open one isn't necessarily mine. Both buttons are always shown; the
  // server enforces "already clocked in" / "not clocked in" and the alert
  // on failure tells the person which state they're actually in.
  async function clockIn() {
    setBusy(true);
    try {
      await apiPost(`${base(slug)}/attendance/clock-in`, { note: note || undefined });
      setNote("");
      await load();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not clock in.");
    } finally {
      setBusy(false);
    }
  }

  async function clockOut() {
    setBusy(true);
    try {
      await apiPost(`${base(slug)}/attendance/clock-out`, { note: note || undefined });
      setNote("");
      await load();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not clock out.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="text-sm text-neutral-500">Loading attendance…</p>;

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="rounded-2xl border border-neutral-200 bg-white p-4">
        <p className="mb-2 text-sm font-semibold text-neutral-900">My shift</p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note"
            className="input sm:max-w-xs"
          />
          <div className="flex gap-2">
            <button disabled={busy} onClick={clockIn} className="btn-primary">
              Clock in
            </button>
            <button disabled={busy} onClick={clockOut} className="btn-secondary">
              Clock out
            </button>
          </div>
        </div>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              {canViewAll && <th className="px-3 py-2">Staff</th>}
              <th className="px-3 py-2">Clock in</th>
              <th className="px-3 py-2">Clock out</th>
              <th className="px-3 py-2">Duration</th>
              <th className="px-3 py-2">Note</th>
            </tr>
          </thead>
          <tbody>
            {records.length === 0 && (
              <tr>
                <td colSpan={canViewAll ? 5 : 4} className="px-3 py-6 text-center text-neutral-400">
                  No attendance records yet.
                </td>
              </tr>
            )}
            {records.map((r) => (
              <tr key={r.id} className="border-t border-neutral-100">
                {canViewAll && <td className="px-3 py-2 font-medium text-neutral-900">{r.fullName}</td>}
                <td className="px-3 py-2">{new Date(r.clockInAt).toLocaleString()}</td>
                <td className="px-3 py-2">
                  {r.clockOutAt ? (
                    new Date(r.clockOutAt).toLocaleString()
                  ) : (
                    <span className="font-medium text-green-700">Still clocked in</span>
                  )}
                </td>
                <td className="px-3 py-2 text-neutral-500">{formatDuration(computeDurationMinutes(r))}</td>
                <td className="px-3 py-2 text-neutral-500">{r.note || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
