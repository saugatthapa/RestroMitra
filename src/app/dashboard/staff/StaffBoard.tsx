"use client";

import { useEffect, useMemo, useState } from "react";
import { apiGet, apiPost, apiPatch, ApiError } from "@/lib/api-client";
import { ASSIGNABLE_STAFF_ROLES, STAFF_ROLE_LABELS, type AssignableStaffRole } from "@/lib/staff-roles";
import { computeDurationMinutes, formatDuration } from "@/lib/attendance";
import { useDateSystem } from "@/lib/date-system";
import { formatDate } from "@/lib/nepali-date";
import { formatNPR } from "@/lib/money";
import { SALARY_TYPES, SALARY_TYPE_LABELS, type SalaryType } from "@/lib/finance/salary-type";
import { PAYOUT_METHODS, PAYOUT_METHOD_LABELS, type PayoutMethod } from "@/lib/finance/payout-methods";

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

type PayrollStaffMember = {
  userRoleId: string;
  userId: string;
  fullName: string;
  phone: string;
  role: string;
  salary: SalaryConfig | null;
  lastPaidAt: string | null;
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

const ALL_TABS = ["Roster", "Attendance", "Payroll"] as const;
type Tab = (typeof ALL_TABS)[number];

export function StaffBoard({
  slug,
  canManageStaff,
  canViewPayroll,
  canManagePayroll,
}: {
  slug: string;
  canManageStaff: boolean;
  canViewPayroll: boolean;
  canManagePayroll: boolean;
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
      {tab === "Attendance" && <AttendanceTab slug={slug} />}
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

      <div className="flex justify-end">
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
        If this phone number already has a RestroMitra account, they&apos;re just granted a role here —
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

function AttendanceTab({ slug }: { slug: string }) {
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [canViewAll, setCanViewAll] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const dateSystem = useDateSystem();

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
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Payroll tab (Phase 22)
// ---------------------------------------------------------------------------

function PayrollTab({ slug, canManagePayroll }: { slug: string; canManagePayroll: boolean }) {
  const [staff, setStaff] = useState<PayrollStaffMember[]>([]);
  const [payments, setPayments] = useState<PayrollPayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [payingFor, setPayingFor] = useState<PayrollStaffMember | null>(null);
  const dateSystem = useDateSystem();

  async function load() {
    try {
      const [staffRes, paymentsRes] = await Promise.all([
        apiGet<{ staff: PayrollStaffMember[] }>(`${base(slug)}/payroll/staff`),
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
  }, [slug]);

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

      <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Role</th>
              <th className="px-3 py-2">Salary</th>
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
                <td colSpan={5} className="px-3 py-6 text-center text-neutral-400">
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
                  {canManagePayroll && !p.isVoided && (
                    <button
                      onClick={() => voidPayment(p)}
                      className="text-xs font-medium text-neutral-500 hover:text-red-600 hover:underline"
                    >
                      Void
                    </button>
                  )}
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
  onClose,
  onPaid,
}: {
  slug: string;
  staff: PayrollStaffMember;
  onClose: () => void;
  onPaid: () => void;
}) {
  const [amount, setAmount] = useState(
    staff.salary ? String(staff.salary.amountInPaisa / 100) : "",
  );
  const [method, setMethod] = useState<PayoutMethod>(staff.salary?.paymentMethod ?? "cash");
  const [payPeriodLabel, setPayPeriodLabel] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/payroll/payments`, {
        userRoleId: staff.userRoleId,
        amount: Number(amount),
        paymentMethod: method,
        payPeriodLabel: payPeriodLabel || undefined,
        note: note || undefined,
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
        </div>

        {method === "cash" ? (
          <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Cash payment — enter the exact amount you handed over above.
          </p>
        ) : (
          <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            RestroMitra can&apos;t automatically verify {PAYOUT_METHOD_LABELS[method].toLowerCase()} transfers — only
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
