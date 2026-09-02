"use client";

import { useEffect, useMemo, useState } from "react";
import { apiGet, apiPost, apiPatch, ApiError } from "@/lib/api-client";
import { ASSIGNABLE_STAFF_ROLES, STAFF_ROLE_LABELS, type AssignableStaffRole } from "@/lib/staff-roles";
import {
  computeDurationMinutes,
  formatDuration,
  ATTENDANCE_STATUS_LABELS,
  type AttendanceStatus,
} from "@/lib/attendance";
import { useDateSystem } from "@/lib/date-system";
import { formatDate } from "@/lib/nepali-date";
import { formatNPR } from "@/lib/money";
import { localDateIso, firstOfMonthIso } from "@/lib/local-date";
import { SALARY_TYPES, SALARY_TYPE_LABELS, type SalaryType } from "@/lib/finance/salary-type";
import { PAYOUT_METHODS, PAYOUT_METHOD_LABELS, type PayoutMethod } from "@/lib/finance/payout-methods";
import { SelfieClockModal } from "./SelfieClockModal";
import { AttendanceReviewModal } from "./AttendanceReviewModal";
import { LeaveTab } from "./LeaveTab";
import { ScheduleTab } from "./ScheduleTab";

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
  hasClockInPhoto: boolean;
  hasClockOutPhoto: boolean;
  // P2 gap-audit fix — the separate workplace/surroundings photo.
  hasClockInWorkplacePhoto: boolean;
  hasClockOutWorkplacePhoto: boolean;
  status: AttendanceStatus;
  reviewedAt: string | null;
  reviewNote: string | null;
  reviewedByName: string | null;
};

const ATTENDANCE_STATUS_BADGE_CLASS: Record<AttendanceStatus, string> = {
  needs_review: "bg-amber-50 text-amber-700",
  verified: "bg-green-50 text-green-700",
  rejected: "bg-red-50 text-red-700",
};

function AttendanceStatusBadge({ status }: { status: AttendanceStatus }) {
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${ATTENDANCE_STATUS_BADGE_CLASS[status]}`}
    >
      {ATTENDANCE_STATUS_LABELS[status]}
    </span>
  );
}

type SalaryConfig = {
  id: string;
  salaryType: SalaryType;
  amountInPaisa: number;
  paymentMethod: PayoutMethod | null;
  bankName: string | null;
  bankAccountNumber: string | null;
  bankAccountHolder: string | null;
  note: string | null;
};

type PayrollComputation = {
  salaryType: SalaryType;
  standingAmountInPaisa: number;
  attendanceMinutes: number;
  attendanceDays: number;
  // Phase 16 (Attendance overhaul, Track B) — approved, non-unpaid leave
  // days within the period; folded into owedAmountInPaisa for "daily" pay
  // only, merely informational for hourly/monthly (see payroll.ts).
  paidLeaveDays: number;
  owedAmountInPaisa: number;
};

type PayrollStaffMember = {
  userRoleId: string;
  userId: string;
  fullName: string;
  phone: string;
  role: string;
  salary: SalaryConfig | null;
  lastPaidAt: string | null;
  // Commercial Launch Phase B.2 — present only when the Payroll tab's period
  // picker sent ?periodStart=&periodEnd= and this staff member has a salary
  // config; null otherwise (see payroll/staff route.ts's doc comment).
  computation: PayrollComputation | null;
};

type PayrollPayment = {
  id: string;
  userRoleId: string;
  staffNameSnapshot: string;
  amountInPaisa: number;
  payPeriodLabel: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  paymentMethod: PayoutMethod;
  note: string | null;
  isVoided: boolean;
  paidAt: string;
};

function base(slug: string) {
  return `/api/restaurants/${slug}`;
}

const ALL_TABS = ["Roster", "Attendance", "Schedule", "Leave", "Payroll"] as const;
type Tab = (typeof ALL_TABS)[number];

export function StaffBoard({
  slug,
  canManageStaff,
  canViewPayroll,
  canManagePayroll,
  canManageAttendanceSettings,
}: {
  slug: string;
  canManageStaff: boolean;
  canViewPayroll: boolean;
  canManagePayroll: boolean;
  canManageAttendanceSettings: boolean;
}) {
  // A person with staff perms but no payroll perms (e.g. a manager) only
  // sees Roster/Attendance; one with payroll perms but no staff perms
  // (e.g. an accountant, who deliberately doesn't hold MANAGE_STAFF) only
  // sees Payroll — same page, different slice, per whichever permission
  // actually got them here (see page.tsx's broadened access gate).
  const visibleTabs = useMemo(
    () =>
      ALL_TABS.filter((t) =>
        t === "Payroll" ? canViewPayroll || canManagePayroll : canManageStaff,
      ),
    [canManageStaff, canViewPayroll, canManagePayroll],
  );
  const [tab, setTab] = useState<Tab>(visibleTabs[0] ?? "Roster");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 border-b border-neutral-200">
        {visibleTabs.map((t) => (
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

      {tab === "Roster" && (
        <RosterTab slug={slug} canManageStaff={canManageStaff} canManagePayroll={canManagePayroll} />
      )}
      {tab === "Attendance" && (
        <AttendanceTab slug={slug} canManageAttendanceSettings={canManageAttendanceSettings} />
      )}
      {tab === "Schedule" && <ScheduleTab slug={slug} canManageStaff={canManageStaff} />}
      {tab === "Leave" && <LeaveTab slug={slug} canManageStaff={canManageStaff} />}
      {tab === "Payroll" && (
        <PayrollTab slug={slug} canManagePayroll={canManagePayroll} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Roster tab
// ---------------------------------------------------------------------------

function RosterTab({
  slug,
  canManageStaff,
  canManagePayroll,
}: {
  slug: string;
  canManageStaff: boolean;
  canManagePayroll: boolean;
}) {
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

      <div className="flex justify-end gap-2">
        <a href={`${base(slug)}/staff/export`} download className="btn-secondary text-xs">
          Export CSV
        </a>
        <button onClick={() => setShowAdd((v) => !v)} className="btn-primary">
          {showAdd ? "Cancel" : "+ Add staff"}
        </button>
      </div>

      {showAdd && (
        <AddStaffForm
          slug={slug}
          branches={branches}
          canManagePayroll={canManagePayroll}
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
  const [resettingPassword, setResettingPassword] = useState(false);
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
          <div className="flex justify-end gap-3">
            <button
              disabled={saving}
              onClick={() => setResettingPassword(true)}
              className="text-xs font-medium text-neutral-500 hover:text-neutral-800 hover:underline"
            >
              Reset password
            </button>
            <button
              disabled={saving}
              onClick={toggleActive}
              className="text-xs font-medium text-orange-700 hover:underline"
            >
              {member.isActive ? "Deactivate" : "Reactivate"}
            </button>
          </div>
        )}
      </td>
      {resettingPassword && (
        <ResetStaffPasswordModal
          slug={slug}
          member={member}
          onClose={() => setResettingPassword(false)}
          onDone={() => setResettingPassword(false)}
        />
      )}
    </tr>
  );
}

function ResetStaffPasswordModal({
  slug,
  member,
  onClose,
  onDone,
}: {
  slug: string;
  member: StaffMember;
  onClose: () => void;
  onDone: () => void;
}) {
  const [newPassword, setNewPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/staff/${member.id}/reset-password`, { newPassword });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reset this password.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-5 shadow-lg">
        {done ? (
          <>
            <p className="mb-1 text-sm font-semibold text-neutral-900">Password reset</p>
            <p className="mb-4 text-sm text-neutral-600">
              {member.fullName}&apos;s password has been changed. Share the new password with them
              directly — they&apos;ve been logged out everywhere and will need it to log back in.
            </p>
            <div className="flex justify-end">
              <button onClick={onDone} className="btn-primary">
                Done
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={submit}>
            <p className="mb-1 text-sm font-semibold text-neutral-900">Reset {member.fullName}&apos;s password</p>
            <p className="mb-3 text-xs text-neutral-500">
              Use this when a staff member is locked out and can&apos;t reset it themselves (no
              email on file, or the reset link never arrives). This immediately logs them out
              everywhere.
            </p>
            {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
            <label className="block text-sm">
              <span className="mb-1 block text-neutral-600">New password</span>
              <input
                required
                type="text"
                minLength={8}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="input"
                placeholder="At least 8 characters"
                autoFocus
              />
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={onClose} className="btn-secondary" disabled={saving}>
                Cancel
              </button>
              <button disabled={saving} className="btn-primary">
                {saving ? "Resetting…" : "Reset password"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function AddStaffForm({
  slug,
  branches,
  canManagePayroll,
  onAdded,
}: {
  slug: string;
  branches: Branch[];
  canManagePayroll: boolean;
  onAdded: () => void;
}) {
  const [phone, setPhone] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<AssignableStaffRole>("waiter");
  const [branchId, setBranchId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Salary fields — only ever shown/submitted for a caller who holds
  // MANAGE_PAYROLL (an owner or accountant); a manager adding a cashier
  // never sees this section at all, matching the "salary stays private"
  // permission wall (see permissions.ts and the staff route's own
  // comment). `setSalary` off entirely means "skip pay info for now, fill
  // it in later from the Payroll tab."
  const [setSalary, setSetSalary] = useState(false);
  const [salaryType, setSalaryType] = useState<SalaryType>("monthly");
  const [salaryAmount, setSalaryAmount] = useState("");
  const [salaryMethod, setSalaryMethod] = useState<PayoutMethod>("cash");
  const [bankName, setBankName] = useState("");
  const [bankAccountNumber, setBankAccountNumber] = useState("");
  const [bankAccountHolder, setBankAccountHolder] = useState("");

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
        salary:
          canManagePayroll && setSalary && salaryAmount
            ? {
                salaryType,
                amount: Number(salaryAmount),
                paymentMethod: salaryMethod,
                bankName: salaryMethod === "bank_transfer" ? bankName || undefined : undefined,
                bankAccountNumber:
                  salaryMethod === "bank_transfer" ? bankAccountNumber || undefined : undefined,
                bankAccountHolder:
                  salaryMethod === "bank_transfer" ? bankAccountHolder || undefined : undefined,
              }
            : undefined,
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
        If this phone number already has a RestroKendra account, they&apos;re just granted a role here —
        name and password are ignored. Otherwise a new account is created with the name and password
        above.
      </p>

      {canManagePayroll && (
        <div className="mt-4 rounded-xl border border-neutral-200 bg-neutral-50 p-3">
          <label className="flex items-center gap-2 text-sm font-medium text-neutral-800">
            <input type="checkbox" checked={setSalary} onChange={(e) => setSetSalary(e.target.checked)} />
            Set up their salary now
          </label>
          {setSalary && (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="text-sm">
                <span className="mb-1 block text-neutral-600">Salary type</span>
                <select
                  value={salaryType}
                  onChange={(e) => setSalaryType(e.target.value as SalaryType)}
                  className="input"
                >
                  {SALARY_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {SALARY_TYPE_LABELS[t]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-neutral-600">
                  {salaryType === "monthly" ? "Amount per month (Rs)" : salaryType === "daily" ? "Amount per day (Rs)" : "Amount per hour (Rs)"}
                </span>
                <input
                  required={setSalary}
                  type="number"
                  min="0"
                  step="0.01"
                  value={salaryAmount}
                  onChange={(e) => setSalaryAmount(e.target.value)}
                  className="input"
                  placeholder="0.00"
                />
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-neutral-600">Usual payment method</span>
                <select
                  value={salaryMethod}
                  onChange={(e) => setSalaryMethod(e.target.value as PayoutMethod)}
                  className="input"
                >
                  {PAYOUT_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {PAYOUT_METHOD_LABELS[m]}
                    </option>
                  ))}
                </select>
              </label>
              {salaryMethod === "bank_transfer" && (
                <>
                  <label className="text-sm">
                    <span className="mb-1 block text-neutral-600">Bank name</span>
                    <input value={bankName} onChange={(e) => setBankName(e.target.value)} className="input" />
                  </label>
                  <label className="text-sm">
                    <span className="mb-1 block text-neutral-600">Account number</span>
                    <input
                      value={bankAccountNumber}
                      onChange={(e) => setBankAccountNumber(e.target.value)}
                      className="input"
                    />
                  </label>
                  <label className="text-sm">
                    <span className="mb-1 block text-neutral-600">Account holder name</span>
                    <input
                      value={bankAccountHolder}
                      onChange={(e) => setBankAccountHolder(e.target.value)}
                      className="input"
                    />
                  </label>
                </>
              )}
            </div>
          )}
          <p className="mt-2 text-xs text-neutral-400">
            You can skip this and set it up later from the Payroll tab.
          </p>
        </div>
      )}

      <button disabled={saving} className="btn-primary mt-3">
        {saving ? "Adding…" : "Add staff member"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Attendance tab
// ---------------------------------------------------------------------------

function AttendanceTab({
  slug,
  canManageAttendanceSettings,
}: {
  slug: string;
  canManageAttendanceSettings: boolean;
}) {
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [canViewAll, setCanViewAll] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [selfieRequired, setSelfieRequired] = useState(false);
  // P2 gap-audit fix — the separate, independently-toggleable
  // workplace-photo requirement.
  const [workplacePhotoRequired, setWorkplacePhotoRequired] = useState(false);
  const [objectStorageConfigured, setObjectStorageConfigured] = useState(false);
  // Queue of captures still needed before the pending clock-in/out can
  // actually submit — e.g. ["selfie", "workplace"] when both are required.
  // Rendered one modal at a time (SelfieClockModal, reused/parameterized
  // per P2 gap-audit fix) so this never asks for two camera streams at
  // once.
  const [pendingClockKind, setPendingClockKind] = useState<"clock_in" | "clock_out" | null>(null);
  const [captureQueue, setCaptureQueue] = useState<("selfie" | "workplace")[]>([]);
  const [pendingSelfieKey, setPendingSelfieKey] = useState<string | undefined>(undefined);
  const [pendingWorkplaceKey, setPendingWorkplaceKey] = useState<string | undefined>(undefined);
  const [attachWorkplacePhoto, setAttachWorkplacePhoto] = useState(false);
  const [photoLoadingId, setPhotoLoadingId] = useState<string | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [reviewingRecord, setReviewingRecord] = useState<AttendanceRecord | null>(null);
  const [needsReviewOnly, setNeedsReviewOnly] = useState(false);
  const dateSystem = useDateSystem();

  async function load() {
    try {
      const [attendanceRes, settingsRes] = await Promise.all([
        apiGet<{ records: AttendanceRecord[]; canViewAll: boolean }>(`${base(slug)}/attendance`),
        apiGet<{
          selfieClockInRequired: boolean;
          workplacePhotoRequired: boolean;
          objectStorageConfigured: boolean;
        }>(`${base(slug)}/attendance/settings`),
      ]);
      setRecords(attendanceRes.records);
      setCanViewAll(attendanceRes.canViewAll);
      setSelfieRequired(settingsRes.selfieClockInRequired);
      setWorkplacePhotoRequired(settingsRes.workplacePhotoRequired);
      setObjectStorageConfigured(settingsRes.objectStorageConfigured);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load attendance.");
    } finally {
      setLoading(false);
    }
  }

  async function toggleSelfieRequired(next: boolean) {
    setSettingsBusy(true);
    setSettingsError(null);
    try {
      const res = await apiPatch<{ selfieClockInRequired: boolean }>(`${base(slug)}/attendance/settings`, {
        selfieClockInRequired: next,
      });
      setSelfieRequired(res.selfieClockInRequired);
    } catch (err) {
      setSettingsError(err instanceof ApiError ? err.message : "Could not update this setting.");
    } finally {
      setSettingsBusy(false);
    }
  }

  // P2 gap-audit fix — same shape as toggleSelfieRequired above, for the
  // separate workplace-photo requirement.
  async function toggleWorkplacePhotoRequired(next: boolean) {
    setSettingsBusy(true);
    setSettingsError(null);
    try {
      const res = await apiPatch<{ workplacePhotoRequired: boolean }>(`${base(slug)}/attendance/settings`, {
        workplacePhotoRequired: next,
      });
      setWorkplacePhotoRequired(res.workplacePhotoRequired);
    } catch (err) {
      setSettingsError(err instanceof ApiError ? err.message : "Could not update this setting.");
    } finally {
      setSettingsBusy(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  // No client-side "am I currently clocked in?" guess: when canViewAll is
  // true, `records` includes every staff member's shifts, so the first
  // open one isn't necessarily mine. Both buttons are always shown; the
  // server enforces "already clocked in" / "not clocked in" and the alert
  // on failure tells the person which state they're actually in.
  async function submitClock(kind: "clock_in" | "clock_out", photoObjectKey?: string, workplacePhotoObjectKey?: string) {
    setBusy(true);
    try {
      await apiPost(`${base(slug)}/attendance/${kind === "clock_in" ? "clock-in" : "clock-out"}`, {
        note: note || undefined,
        photoObjectKey,
        workplacePhotoObjectKey,
      });
      setNote("");
      setAttachWorkplacePhoto(false);
      await load();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : `Could not ${kind === "clock_in" ? "clock in" : "clock out"}.`);
    } finally {
      setBusy(false);
    }
  }

  // P2 gap-audit fix — builds the queue of photo(s) to capture before this
  // clock-in/out can submit: the selfie when the restaurant requires it,
  // then the separate workplace photo when the restaurant requires THAT
  // (independent toggle) or the staff member opted into attaching one
  // voluntarily. Captures run one at a time (see the modal rendering
  // below) so at most one camera stream is ever open.
  function startClock(kind: "clock_in" | "clock_out") {
    const queue: ("selfie" | "workplace")[] = [];
    if (selfieRequired) queue.push("selfie");
    if (workplacePhotoRequired || attachWorkplacePhoto) queue.push("workplace");

    if (queue.length === 0) {
      submitClock(kind);
      return;
    }
    setPendingClockKind(kind);
    setPendingSelfieKey(undefined);
    setPendingWorkplaceKey(undefined);
    setCaptureQueue(queue);
  }

  // Called when one capture in the queue finishes — either submits (this
  // was the last one needed) or advances to the next.
  function handleCaptureDone(purpose: "selfie" | "workplace", photoObjectKey: string) {
    const selfieKey = purpose === "selfie" ? photoObjectKey : pendingSelfieKey;
    const workplaceKey = purpose === "workplace" ? photoObjectKey : pendingWorkplaceKey;
    const remaining = captureQueue.slice(1);

    if (remaining.length === 0) {
      const kind = pendingClockKind;
      setCaptureQueue([]);
      setPendingClockKind(null);
      setPendingSelfieKey(undefined);
      setPendingWorkplaceKey(undefined);
      if (kind) submitClock(kind, selfieKey, workplaceKey);
      return;
    }
    setPendingSelfieKey(selfieKey);
    setPendingWorkplaceKey(workplaceKey);
    setCaptureQueue(remaining);
  }

  function cancelCapture() {
    setCaptureQueue([]);
    setPendingClockKind(null);
    setPendingSelfieKey(undefined);
    setPendingWorkplaceKey(undefined);
  }

  async function viewPhoto(
    recordId: string,
    kind: "clock_in" | "clock_out" | "clock_in_workplace" | "clock_out_workplace",
  ) {
    setPhotoLoadingId(`${recordId}:${kind}`);
    try {
      const res = await apiGet<{ url: string }>(`${base(slug)}/attendance/${recordId}/photo?kind=${kind}`);
      window.open(res.url, "_blank", "noopener,noreferrer");
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not open that photo.");
    } finally {
      setPhotoLoadingId(null);
    }
  }

  const needsReviewCount = records.filter((r) => r.status === "needs_review").length;
  const visibleRecords = needsReviewOnly ? records.filter((r) => r.status === "needs_review") : records;

  if (loading) return <p className="text-sm text-neutral-500">Loading attendance…</p>;

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="rounded-2xl border border-neutral-200 bg-white p-4">
        <p className="mb-2 text-sm font-semibold text-neutral-900">My shift</p>
        {selfieRequired && (
          <p className="mb-2 text-xs text-neutral-500">
            This restaurant requires a selfie to clock in and out.
          </p>
        )}
        {workplacePhotoRequired && (
          <p className="mb-2 text-xs text-neutral-500">
            This restaurant also requires a workplace photo to clock in and out.
          </p>
        )}
        {/* P2 gap-audit fix — voluntary opt-in when the restaurant hasn't
            made the workplace photo mandatory; hidden (and irrelevant)
            once it already is, or when this deployment has no photo
            storage to upload it to. */}
        {!workplacePhotoRequired && objectStorageConfigured && (
          <label className="mb-2 flex items-center gap-2 text-xs text-neutral-600">
            <input
              type="checkbox"
              checked={attachWorkplacePhoto}
              onChange={(e) => setAttachWorkplacePhoto(e.target.checked)}
            />
            Also attach a workplace photo
          </label>
        )}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note"
            className="input sm:max-w-xs"
          />
          <div className="flex gap-2">
            <button disabled={busy} onClick={() => startClock("clock_in")} className="btn-primary">
              Clock in
            </button>
            <button disabled={busy} onClick={() => startClock("clock_out")} className="btn-secondary">
              Clock out
            </button>
          </div>
        </div>
      </div>

      {canManageAttendanceSettings && (
        <div className="rounded-2xl border border-neutral-200 bg-white p-4">
          <p className="mb-1 text-sm font-semibold text-neutral-900">Photo-verified attendance</p>
          {objectStorageConfigured ? (
            <>
              <p className="mb-2 text-xs text-neutral-500">
                Two separate, independent checks: a selfie proves WHO is clocking in; a workplace photo
                proves they&apos;re actually AT the restaurant. Turn on either, both, or neither. Staff are
                shown a consent notice the first time either applies to them.
              </p>
              {settingsError && <p className="mb-2 text-sm text-red-600">{settingsError}</p>}
              <label className="mb-1 flex items-center gap-2 text-sm text-neutral-700">
                <input
                  type="checkbox"
                  checked={selfieRequired}
                  disabled={settingsBusy}
                  onChange={(e) => toggleSelfieRequired(e.target.checked)}
                />
                Require a selfie to clock in/out
              </label>
              <label className="flex items-center gap-2 text-sm text-neutral-700">
                <input
                  type="checkbox"
                  checked={workplacePhotoRequired}
                  disabled={settingsBusy}
                  onChange={(e) => toggleWorkplacePhotoRequired(e.target.checked)}
                />
                Require a workplace photo to clock in/out
              </label>
            </>
          ) : (
            <p className="text-xs text-neutral-500">
              Not available yet — this deployment hasn&apos;t configured photo storage.
            </p>
          )}
        </div>
      )}

      {/* P2 gap-audit fix — one capture modal at a time, driven by
          captureQueue; SelfieClockModal is reused unmodified, just
          parameterized by `purpose`. */}
      {pendingClockKind && captureQueue[0] === "selfie" && (
        <SelfieClockModal
          slug={slug}
          kind={pendingClockKind}
          purpose="selfie"
          onDone={(photoObjectKey) => handleCaptureDone("selfie", photoObjectKey)}
          onClose={cancelCapture}
        />
      )}
      {pendingClockKind && captureQueue[0] === "workplace" && (
        <SelfieClockModal
          slug={slug}
          kind={pendingClockKind}
          purpose="workplace"
          onDone={(photoObjectKey) => handleCaptureDone("workplace", photoObjectKey)}
          onClose={cancelCapture}
        />
      )}

      {canViewAll && <AttendanceAnalyticsPanel slug={slug} />}

      {canViewAll && needsReviewCount > 0 && (
        <label className="flex items-center gap-2 text-sm text-neutral-700">
          <input
            type="checkbox"
            checked={needsReviewOnly}
            onChange={(e) => setNeedsReviewOnly(e.target.checked)}
          />
          Show only shifts needing review ({needsReviewCount})
        </label>
      )}

      <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              {canViewAll && <th className="px-3 py-2">Staff</th>}
              <th className="px-3 py-2">Clock in</th>
              <th className="px-3 py-2">Clock out</th>
              <th className="px-3 py-2">Duration</th>
              <th className="px-3 py-2">Note</th>
              <th className="px-3 py-2">Photos</th>
              {canViewAll && <th className="px-3 py-2">Status</th>}
              {canViewAll && <th className="px-3 py-2"></th>}
            </tr>
          </thead>
          <tbody>
            {visibleRecords.length === 0 && (
              <tr>
                <td colSpan={canViewAll ? 8 : 5} className="px-3 py-6 text-center text-neutral-400">
                  {records.length === 0 ? "No attendance records yet." : "No shifts need review right now."}
                </td>
              </tr>
            )}
            {visibleRecords.map((r) => (
              <tr key={r.id} className="border-t border-neutral-100">
                {canViewAll && <td className="px-3 py-2 font-medium text-neutral-900">{r.fullName}</td>}
                <td className="px-3 py-2">{formatDate(r.clockInAt, dateSystem, { withTime: true })}</td>
                <td className="px-3 py-2">
                  {r.clockOutAt ? (
                    formatDate(r.clockOutAt, dateSystem, { withTime: true })
                  ) : (
                    <span className="font-medium text-green-700">Still clocked in</span>
                  )}
                </td>
                <td className="px-3 py-2 text-neutral-500">{formatDuration(computeDurationMinutes(r))}</td>
                <td className="px-3 py-2 text-neutral-500">{r.note || "—"}</td>
                <td className="px-3 py-2">
                  <div className="flex gap-2 text-xs">
                    {r.hasClockInPhoto && (
                      <button
                        type="button"
                        disabled={photoLoadingId === `${r.id}:clock_in`}
                        onClick={() => viewPhoto(r.id, "clock_in")}
                        className="text-orange-700 underline hover:text-orange-800"
                        title="Selfie at clock-in"
                      >
                        In
                      </button>
                    )}
                    {r.hasClockOutPhoto && (
                      <button
                        type="button"
                        disabled={photoLoadingId === `${r.id}:clock_out`}
                        onClick={() => viewPhoto(r.id, "clock_out")}
                        className="text-orange-700 underline hover:text-orange-800"
                        title="Selfie at clock-out"
                      >
                        Out
                      </button>
                    )}
                    {/* P2 gap-audit fix — the separate workplace photo, clearly distinguished by label from the selfie above. */}
                    {r.hasClockInWorkplacePhoto && (
                      <button
                        type="button"
                        disabled={photoLoadingId === `${r.id}:clock_in_workplace`}
                        onClick={() => viewPhoto(r.id, "clock_in_workplace")}
                        className="text-teal-700 underline hover:text-teal-800"
                        title="Workplace photo at clock-in"
                      >
                        Workplace (in)
                      </button>
                    )}
                    {r.hasClockOutWorkplacePhoto && (
                      <button
                        type="button"
                        disabled={photoLoadingId === `${r.id}:clock_out_workplace`}
                        onClick={() => viewPhoto(r.id, "clock_out_workplace")}
                        className="text-teal-700 underline hover:text-teal-800"
                        title="Workplace photo at clock-out"
                      >
                        Workplace (out)
                      </button>
                    )}
                    {!r.hasClockInPhoto &&
                      !r.hasClockOutPhoto &&
                      !r.hasClockInWorkplacePhoto &&
                      !r.hasClockOutWorkplacePhoto && <span className="text-neutral-300">—</span>}
                  </div>
                </td>
                {canViewAll && (
                  <td className="px-3 py-2">
                    <AttendanceStatusBadge status={r.status} />
                  </td>
                )}
                {canViewAll && (
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      onClick={() => setReviewingRecord(r)}
                      className="text-orange-700 underline hover:text-orange-800"
                    >
                      Review
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {reviewingRecord && (
        <AttendanceReviewModal
          slug={slug}
          record={reviewingRecord}
          onUpdated={load}
          onClose={() => setReviewingRecord(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Attendance analytics panel (Phase 16, Attendance overhaul Track B) — a
// per-staff summary table for a chosen period, mounted inside the
// Attendance tab and visible only to whoever already sees everyone's
// records there (canViewAll — MANAGE_STAFF). Own period picker rather than
// sharing the Payroll tab's, since the two live on different tabs and a
// manager may well want to look at a different window for "who's been
// late" than for "what am I paying this month."
// ---------------------------------------------------------------------------

type StaffAttendanceAnalyticsRow = {
  userId: string;
  fullName: string;
  totalMinutes: number;
  daysPresent: number;
  rejectedShiftsCount: number;
  paidLeaveDays: number;
  scheduledShiftsCount: number;
  completedShiftsCount: number;
  noShowCount: number;
  lateCount: number;
  totalLateMinutes: number;
  totalEarlyDepartureMinutes: number;
  excusedLeaveCount: number;
  excusedHolidayCount: number;
};

function AttendanceAnalyticsPanel({ slug }: { slug: string }) {
  const [expanded, setExpanded] = useState(false);
  const [staff, setStaff] = useState<StaffAttendanceAnalyticsRow[]>([]);
  const [periodStart, setPeriodStart] = useState(firstOfMonthIso());
  const [periodEnd, setPeriodEnd] = useState(localDateIso());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedOnce, setLoadedOnce] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const params = new URLSearchParams({ periodStart, periodEnd });
      const res = await apiGet<{ staff: StaffAttendanceAnalyticsRow[]; periodStart: string; periodEnd: string }>(
        `${base(slug)}/attendance/analytics?${params.toString()}`,
      );
      setStaff(res.staff);
      setPeriodStart(res.periodStart);
      setPeriodEnd(res.periodEnd);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load attendance analytics.");
    } finally {
      setLoading(false);
      setLoadedOnce(true);
    }
  }

  useEffect(() => {
    if (expanded && !loadedOnce) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  return (
    <div className="rounded-2xl border border-neutral-200 bg-white p-3 shadow-sm">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between text-left text-sm font-medium text-neutral-800"
      >
        <span>Attendance analytics</span>
        <span className="text-xs text-neutral-400">{expanded ? "Hide" : "Show"}</span>
      </button>

      {expanded && (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-sm text-neutral-600">
              From
              <input
                type="date"
                value={periodStart}
                max={periodEnd}
                onChange={(e) => setPeriodStart(e.target.value)}
                className="rounded-md border border-neutral-300 px-2 py-1 text-sm"
              />
            </label>
            <label className="flex items-center gap-1.5 text-sm text-neutral-600">
              To
              <input
                type="date"
                value={periodEnd}
                min={periodStart}
                onChange={(e) => setPeriodEnd(e.target.value)}
                className="rounded-md border border-neutral-300 px-2 py-1 text-sm"
              />
            </label>
            <button
              type="button"
              onClick={load}
              disabled={loading}
              className="rounded-md bg-neutral-900 px-3 py-1 text-sm text-white disabled:opacity-50"
            >
              {loading ? "Loading…" : "Refresh"}
            </button>
            <a
              href={`${base(slug)}/attendance/export?periodStart=${periodStart}&periodEnd=${periodEnd}`}
              download
              className="btn-secondary text-xs"
            >
              Export CSV
            </a>
          </div>

          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

          <div className="overflow-x-auto rounded-xl border border-neutral-100">
            <table className="w-full text-sm">
              <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="px-3 py-2">Staff</th>
                  <th className="px-3 py-2">Worked</th>
                  <th className="px-3 py-2">Days present</th>
                  <th className="px-3 py-2">Paid leave</th>
                  <th className="px-3 py-2">Rejected shifts</th>
                  <th className="px-3 py-2">Scheduled</th>
                  <th className="px-3 py-2">No-shows</th>
                  <th className="px-3 py-2">Late</th>
                  <th className="px-3 py-2">Excused (leave/holiday)</th>
                </tr>
              </thead>
              <tbody>
                {!loading && staff.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-3 py-6 text-center text-neutral-400">
                      No active staff to show for this period.
                    </td>
                  </tr>
                )}
                {staff.map((s) => (
                  <tr key={s.userId} className="border-t border-neutral-100">
                    <td className="px-3 py-2 font-medium text-neutral-900">{s.fullName}</td>
                    <td className="px-3 py-2 text-neutral-600">{formatDuration(s.totalMinutes)}</td>
                    <td className="px-3 py-2 text-neutral-600">{s.daysPresent}</td>
                    <td className="px-3 py-2 text-neutral-600">{s.paidLeaveDays || "—"}</td>
                    <td className="px-3 py-2 text-neutral-600">
                      {s.rejectedShiftsCount > 0 ? (
                        <span className="text-amber-600">{s.rejectedShiftsCount}</span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-3 py-2 text-neutral-600">{s.scheduledShiftsCount || "—"}</td>
                    <td className="px-3 py-2 text-neutral-600">
                      {s.noShowCount > 0 ? <span className="text-red-600">{s.noShowCount}</span> : "—"}
                    </td>
                    <td className="px-3 py-2 text-neutral-600">
                      {s.lateCount > 0 ? (
                        <>
                          {s.lateCount}{" "}
                          <span className="text-xs text-neutral-400">({formatDuration(s.totalLateMinutes)})</span>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-3 py-2 text-neutral-600">
                      {s.excusedLeaveCount + s.excusedHolidayCount > 0 ? (
                        <span className="text-xs text-neutral-500">
                          {s.excusedLeaveCount > 0 && `${s.excusedLeaveCount} leave`}
                          {s.excusedLeaveCount > 0 && s.excusedHolidayCount > 0 && ", "}
                          {s.excusedHolidayCount > 0 && `${s.excusedHolidayCount} holiday`}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Payroll tab (Phase 22)
// ---------------------------------------------------------------------------

/**
 * Phase 16 (Attendance overhaul, Track B) — the "(5 days)" / "(3h 30m)"
 * parenthetical next to an owed amount, extended with a paid-leave note
 * when the period has any. For "daily" pay the leave days are already
 * folded into owedAmountInPaisa (see payroll.ts), so it reads as "+ N paid
 * leave" appended to the days count. For "hourly" (where leave is
 * deliberately NOT folded into pay — no spec for how many hours a leave
 * day is worth) it's called out separately so it doesn't look like part of
 * the worked-hours figure.
 */
function formatComputationDetail(computation: PayrollComputation): string {
  const worked =
    computation.salaryType === "hourly"
      ? formatDuration(computation.attendanceMinutes)
      : `${computation.attendanceDays} day${computation.attendanceDays === 1 ? "" : "s"}`;
  if (computation.paidLeaveDays <= 0) return worked;
  const leaveLabel = `${computation.paidLeaveDays} paid leave day${computation.paidLeaveDays === 1 ? "" : "s"}`;
  return computation.salaryType === "daily" ? `${worked} + ${leaveLabel}` : `${worked}, ${leaveLabel} (not included)`;
}

function PayrollTab({ slug, canManagePayroll }: { slug: string; canManagePayroll: boolean }) {
  const [staff, setStaff] = useState<PayrollStaffMember[]>([]);
  const [payments, setPayments] = useState<PayrollPayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [payingFor, setPayingFor] = useState<PayrollStaffMember | null>(null);
  // Commercial Launch Phase B.2 — defaults to the current calendar month so
  // the roster shows "here's what everyone is owed this month" on first
  // load, same "This month" default reports.ts/ReportsBoard.tsx use.
  const [periodStart, setPeriodStart] = useState(firstOfMonthIso());
  const [periodEnd, setPeriodEnd] = useState(localDateIso());
  const dateSystem = useDateSystem();

  async function load() {
    try {
      const params = new URLSearchParams();
      if (periodStart && periodEnd) {
        params.set("periodStart", periodStart);
        params.set("periodEnd", periodEnd);
      }
      const qs = params.toString();
      const [staffRes, paymentsRes] = await Promise.all([
        apiGet<{ staff: PayrollStaffMember[] }>(`${base(slug)}/payroll/staff${qs ? `?${qs}` : ""}`),
        apiGet<{ payments: PayrollPayment[] }>(`${base(slug)}/payroll/payments`),
      ]);
      setStaff(staffRes.staff);
      setPayments(paymentsRes.payments);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load payroll.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, periodStart, periodEnd]);

  async function voidPayment(payment: PayrollPayment) {
    if (!confirm(`Void the ${formatNPR(payment.amountInPaisa)} payment to ${payment.staffNameSnapshot}? This does not claw back the money — it only corrects the record.`)) {
      return;
    }
    try {
      await apiPatch(`${base(slug)}/payroll/payments/${payment.id}`, {});
      load();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not void this payment.");
    }
  }

  if (loading) return <p className="text-sm text-neutral-500">Loading payroll…</p>;

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-neutral-200 bg-white p-3 shadow-sm">
        <span className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          Owed this period
        </span>
        <label className="flex items-center gap-1.5 text-sm text-neutral-600">
          From
          <input
            type="date"
            value={periodStart}
            max={periodEnd}
            onChange={(e) => setPeriodStart(e.target.value)}
            className="rounded-md border border-neutral-300 px-2 py-1 text-sm"
          />
        </label>
        <label className="flex items-center gap-1.5 text-sm text-neutral-600">
          To
          <input
            type="date"
            value={periodEnd}
            min={periodStart}
            onChange={(e) => setPeriodEnd(e.target.value)}
            className="rounded-md border border-neutral-300 px-2 py-1 text-sm"
          />
        </label>
        <a
          href={`${base(slug)}/payroll/export?from=${periodStart}&to=${periodEnd}`}
          download
          className="btn-secondary text-xs"
        >
          Export CSV
        </a>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Role</th>
              <th className="px-3 py-2">Salary</th>
              <th className="px-3 py-2">Owed (period)</th>
              <th className="px-3 py-2">Last paid</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {staff.map((s) => (
              <tr key={s.userRoleId} className="border-t border-neutral-100">
                <td className="px-3 py-2 font-medium text-neutral-900">{s.fullName}</td>
                <td className="px-3 py-2 capitalize text-neutral-700">{s.role.replace("_", " ")}</td>
                <td className="px-3 py-2 text-neutral-600">
                  {s.salary ? (
                    <>
                      {formatNPR(s.salary.amountInPaisa)}{" "}
                      <span className="text-xs text-neutral-400">/ {SALARY_TYPE_LABELS[s.salary.salaryType].toLowerCase()}</span>
                    </>
                  ) : (
                    <span className="text-neutral-400">Not set</span>
                  )}
                </td>
                <td className="px-3 py-2 text-neutral-600">
                  {s.computation ? (
                    <>
                      {formatNPR(s.computation.owedAmountInPaisa)}
                      {s.computation.salaryType !== "monthly" && (
                        <span className="ml-1 text-xs text-neutral-400">
                          ({formatComputationDetail(s.computation)})
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="text-neutral-400">—</span>
                  )}
                </td>
                <td className="px-3 py-2 text-neutral-500">
                  {s.lastPaidAt ? formatDate(s.lastPaidAt, dateSystem) : "Never"}
                </td>
                <td className="px-3 py-2 text-right">
                  {canManagePayroll && (
                    <button
                      onClick={() => setPayingFor(s)}
                      className="text-xs font-medium text-orange-700 hover:underline"
                    >
                      Pay
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {staff.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-neutral-400">
                  No active staff yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {payingFor && (
        <PaySalaryModal
          slug={slug}
          staff={payingFor}
          periodStart={periodStart}
          periodEnd={periodEnd}
          onClose={() => setPayingFor(null)}
          onPaid={() => {
            setPayingFor(null);
            load();
          }}
        />
      )}

      <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="px-3 py-2">Date</th>
              <th className="px-3 py-2">Staff</th>
              <th className="px-3 py-2">Period</th>
              <th className="px-3 py-2">Method</th>
              <th className="px-3 py-2">Amount</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {payments.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-neutral-400">
                  No payroll payments recorded yet.
                </td>
              </tr>
            )}
            {payments.map((p) => (
              <tr key={p.id} className="border-t border-neutral-100">
                <td className="px-3 py-2 text-neutral-500">{formatDate(p.paidAt, dateSystem)}</td>
                <td className="px-3 py-2 font-medium text-neutral-900">
                  {p.staffNameSnapshot}
                  {p.isVoided && <span className="ml-2 text-xs font-medium text-red-600">Voided</span>}
                </td>
                <td className="px-3 py-2 text-neutral-500">{p.payPeriodLabel || "—"}</td>
                <td className="px-3 py-2 text-neutral-500">{PAYOUT_METHOD_LABELS[p.paymentMethod]}</td>
                <td className="px-3 py-2">{formatNPR(p.amountInPaisa)}</td>
                <td className="px-3 py-2 text-right">
                  <div className="flex justify-end gap-3">
                    <a
                      href={`/print/payslip/${p.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs font-medium text-neutral-500 hover:text-neutral-900 hover:underline"
                    >
                      Payslip
                    </a>
                    {canManagePayroll && !p.isVoided && (
                      <button
                        onClick={() => voidPayment(p)}
                        className="text-xs font-medium text-neutral-500 hover:text-red-600 hover:underline"
                      >
                        Void
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PaySalaryModal({
  slug,
  staff,
  periodStart,
  periodEnd,
  onClose,
  onPaid,
}: {
  slug: string;
  staff: PayrollStaffMember;
  periodStart: string;
  periodEnd: string;
  onClose: () => void;
  onPaid: () => void;
}) {
  // Commercial Launch Phase B.2 — pre-fill from the computed owed amount
  // (attendance × rate) when one's available for this period, falling back
  // to the raw standing salary otherwise; either way it's just a starting
  // point the person confirming the payment can still change.
  const [amount, setAmount] = useState(
    staff.computation
      ? String(staff.computation.owedAmountInPaisa / 100)
      : staff.salary
        ? String(staff.salary.amountInPaisa / 100)
        : "",
  );
  const [method, setMethod] = useState<PayoutMethod>(staff.salary?.paymentMethod ?? "cash");
  const [payPeriodLabel, setPayPeriodLabel] = useState("");
  const [note, setNote] = useState("");
  // Commercial completion pass — payslip generation. Purely itemized,
  // manually-entered withholdings (e.g. "Advance recovery") shown on the
  // printed payslip as "Amount above + deductions = gross"; never a
  // computed statutory figure (see src/lib/payslip.ts's doc comment).
  const [deductions, setDeductions] = useState<Array<{ label: string; amount: string }>>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function addDeduction() {
    setDeductions((prev) => [...prev, { label: "", amount: "" }]);
  }
  function updateDeduction(i: number, patch: Partial<{ label: string; amount: string }>) {
    setDeductions((prev) => prev.map((d, idx) => (idx === i ? { ...d, ...patch } : d)));
  }
  function removeDeduction(i: number) {
    setDeductions((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const cleanDeductions = deductions
        .filter((d) => d.label.trim() && Number(d.amount) > 0)
        .map((d) => ({ label: d.label.trim(), amount: Number(d.amount) }));
      await apiPost(`${base(slug)}/payroll/payments`, {
        userRoleId: staff.userRoleId,
        amount: Number(amount),
        paymentMethod: method,
        payPeriodLabel: payPeriodLabel || undefined,
        periodStart,
        periodEnd,
        note: note || undefined,
        deductions: cleanDeductions.length > 0 ? cleanDeductions : undefined,
      });
      onPaid();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not record this payment.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-5 shadow-lg"
      >
        <p className="mb-1 text-sm font-semibold text-neutral-900">Pay {staff.fullName}</p>
        <p className="mb-3 text-xs text-neutral-500">
          {staff.salary
            ? `Usual salary: ${formatNPR(staff.salary.amountInPaisa)} / ${SALARY_TYPE_LABELS[staff.salary.salaryType].toLowerCase()}`
            : "No standing salary set — enter the amount to pay below."}
        </p>
        {staff.computation && (
          <p className="mb-3 rounded-lg bg-neutral-50 px-3 py-2 text-xs text-neutral-600">
            For {periodStart} to {periodEnd}: {staff.computation.salaryType === "hourly"
              ? formatDuration(staff.computation.attendanceMinutes)
              : staff.computation.salaryType === "daily"
                ? `${staff.computation.attendanceDays} day${staff.computation.attendanceDays === 1 ? "" : "s"} worked`
                : "monthly salary, not prorated by attendance"}
            {staff.computation.paidLeaveDays > 0 &&
              (staff.computation.salaryType === "daily"
                ? ` + ${staff.computation.paidLeaveDays} paid leave day${staff.computation.paidLeaveDays === 1 ? "" : "s"}`
                : staff.computation.salaryType === "hourly"
                  ? `, ${staff.computation.paidLeaveDays} paid leave day${staff.computation.paidLeaveDays === 1 ? "" : "s"} not included above`
                  : "")}
            {" "}— computed{" "}
            {formatNPR(staff.computation.owedAmountInPaisa)}.
          </p>
        )}
        {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <div className="space-y-3">
          <label className="block text-sm">
            <span className="mb-1 block text-neutral-600">Amount (Rs)</span>
            <input
              required
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="input"
              autoFocus
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-neutral-600">Paid via</span>
            <select value={method} onChange={(e) => setMethod(e.target.value as PayoutMethod)} className="input">
              {PAYOUT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {PAYOUT_METHOD_LABELS[m]}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-neutral-600">Period (optional, e.g. &quot;August 2026&quot;)</span>
            <input
              value={payPeriodLabel}
              onChange={(e) => setPayPeriodLabel(e.target.value)}
              className="input"
              placeholder="August 2026"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-neutral-600">Note (optional)</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} className="input" />
          </label>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-sm text-neutral-600">Deductions (optional)</span>
              <button
                type="button"
                onClick={addDeduction}
                className="text-xs font-medium text-neutral-500 hover:text-neutral-900 hover:underline"
              >
                + Add deduction
              </button>
            </div>
            {deductions.length > 0 && (
              <p className="mb-2 text-xs text-neutral-400">
                The amount above is the net amount you&apos;re actually paying. Any deductions listed
                here are shown on the payslip as withheld from gross pay — they don&apos;t change what
                you enter above.
              </p>
            )}
            <div className="space-y-2">
              {deductions.map((d, i) => (
                <div key={i} className="flex gap-2">
                  <input
                    value={d.label}
                    onChange={(e) => updateDeduction(i, { label: e.target.value })}
                    placeholder="e.g. Advance recovery"
                    className="input flex-1"
                  />
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={d.amount}
                    onChange={(e) => updateDeduction(i, { amount: e.target.value })}
                    placeholder="Rs"
                    className="input w-28"
                  />
                  <button
                    type="button"
                    onClick={() => removeDeduction(i)}
                    className="px-2 text-xs font-medium text-neutral-400 hover:text-red-600"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>

        {method === "cash" ? (
          <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Cash payment — enter the exact amount you handed over above.
          </p>
        ) : (
          <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            RestroKendra can&apos;t automatically verify {PAYOUT_METHOD_LABELS[method].toLowerCase()} transfers — only
            confirm this once the money has actually been sent.
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-secondary" disabled={saving}>
            Cancel
          </button>
          <button disabled={saving} className="btn-primary">
            {saving ? "Recording…" : "Mark as paid"}
          </button>
        </div>
      </form>
    </div>
  );
}
