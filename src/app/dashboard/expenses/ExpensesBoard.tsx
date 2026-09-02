"use client";

import { useEffect, useMemo, useState } from "react";
import { apiGet, apiPost, apiPatch, ApiError } from "@/lib/api-client";
import {
  EXPENSE_PAYMENT_METHODS,
  EXPENSE_PAYMENT_METHOD_LABELS,
  type ExpensePaymentMethod,
} from "@/lib/finance/expense-payment-methods";
import { EXPENSE_STATUS_LABELS, type ExpenseStatus } from "@/lib/finance/expense-status";
import { useDateSystem } from "@/lib/date-system";
import { formatDate, formatBsHint } from "@/lib/nepali-date";
import { localDateIso } from "@/lib/local-date";

type ExpenseCategory = { id: string; name: string; isActive: boolean };
type Branch = { id: string; name: string };

type Expense = {
  id: string;
  categoryId: string;
  categoryName: string;
  branchId: string | null;
  branchName: string | null;
  amountInPaisa: number;
  description: string;
  expenseDate: string;
  note: string | null;
  status: ExpenseStatus;
  paymentMethod: ExpensePaymentMethod | null;
  rejectionReason: string | null;
  isVoided: boolean;
  createdAt: string;
};

function base(slug: string) {
  return `/api/restaurants/${slug}`;
}

function formatRupees(paisa: number) {
  return `Rs ${(paisa / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
}

function todayIso() {
  return localDateIso();
}

const STATUS_TONE: Record<ExpenseStatus, string> = {
  pending_approval: "bg-amber-500/15 text-amber-400",
  approved: "bg-blue-500/15 text-blue-400",
  rejected: "bg-red-500/15 text-red-400",
  paid: "bg-emerald-500/15 text-emerald-400",
};

function StatusBadge({ status }: { status: ExpenseStatus }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_TONE[status]}`}>
      {EXPENSE_STATUS_LABELS[status]}
    </span>
  );
}

export function ExpensesBoard({
  slug,
  canCreate,
  canManage,
  canApprove,
  canPay,
}: {
  slug: string;
  canCreate: boolean;
  canManage: boolean;
  canApprove: boolean;
  canPay: boolean;
}) {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [categoryFilter, setCategoryFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<ExpenseStatus | "">("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showCategories, setShowCategories] = useState(false);
  const dateSystem = useDateSystem();

  async function load() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (categoryFilter) params.set("categoryId", categoryFilter);
      if (statusFilter) params.set("status", statusFilter);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const qs = params.toString();
      const [expRes, catRes, branchRes] = await Promise.all([
        apiGet<{ expenses: Expense[] }>(`${base(slug)}/expenses${qs ? `?${qs}` : ""}`),
        apiGet<{ categories: ExpenseCategory[] }>(`${base(slug)}/expense-categories`),
        apiGet<{ branches: Branch[] }>(`${base(slug)}/branches`),
      ]);
      setExpenses(expRes.expenses);
      setCategories(catRes.categories);
      setBranches(branchRes.branches);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load expenses.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, categoryFilter, statusFilter, from, to]);

  const activeCategories = useMemo(() => categories.filter((c) => c.isActive), [categories]);

  const paidExpenses = useMemo(() => expenses.filter((e) => e.status === "paid"), [expenses]);
  const total = useMemo(
    () => paidExpenses.reduce((sum, e) => sum + e.amountInPaisa, 0),
    [paidExpenses],
  );
  const pendingCount = useMemo(
    () => expenses.filter((e) => e.status === "pending_approval").length,
    [expenses],
  );

  const totalsByCategory = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of paidExpenses) {
      map.set(e.categoryName, (map.get(e.categoryName) ?? 0) + e.amountInPaisa);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [paidExpenses]);

  if (!canCreate && !canManage && !canApprove && !canPay) {
    return (
      <p className="text-sm text-ink-faint">
        Your role doesn&apos;t have access to expense tracking.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-400">{error}</p>}

      <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-hairline bg-surface-2 p-4">
        <label className="text-sm">
          <span className="mb-1 block text-ink-secondary">Category</span>
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="input !w-auto"
          >
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-ink-secondary">Status</span>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as ExpenseStatus | "")}
            className="input !w-auto"
          >
            <option value="">All statuses</option>
            {(Object.keys(EXPENSE_STATUS_LABELS) as ExpenseStatus[]).map((s) => (
              <option key={s} value={s}>
                {EXPENSE_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-ink-secondary">From</span>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="input !w-auto" />
          {dateSystem === "BS" && from && (
            <span className="mt-1 block text-xs text-ink-faint">{formatBsHint(from)}</span>
          )}
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-ink-secondary">To</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="input !w-auto" />
          {dateSystem === "BS" && to && (
            <span className="mt-1 block text-xs text-ink-faint">{formatBsHint(to)}</span>
          )}
        </label>
        <div className="ml-auto flex gap-2">
          {canManage && (
            <button onClick={() => setShowCategories((v) => !v)} className="btn-secondary">
              {showCategories ? "Close categories" : "Categories"}
            </button>
          )}
          {(canCreate || canManage) && (
            <button onClick={() => setShowAdd((v) => !v)} className="btn-primary">
              {showAdd ? "Cancel" : "+ Add expense"}
            </button>
          )}
        </div>
      </div>

      {showCategories && canManage && (
        <CategoriesPanel slug={slug} categories={categories} onChanged={load} />
      )}

      {showAdd && (canCreate || canManage) && (
        <AddExpenseForm
          slug={slug}
          categories={activeCategories}
          branches={branches}
          canPay={canPay}
          onAdded={() => {
            setShowAdd(false);
            load();
          }}
        />
      )}

      <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
        <div className="rounded-2xl border border-hairline bg-surface-2 p-4">
          <p className="text-xs text-ink-muted">Total paid (filtered)</p>
          <p className="text-2xl font-semibold text-ink">{formatRupees(total)}</p>
          {pendingCount > 0 && (canApprove || canManage) && (
            <p className="mt-1 text-xs font-medium text-amber-400">
              {pendingCount} awaiting approval
            </p>
          )}
          {totalsByCategory.length > 0 && (
            <ul className="mt-3 space-y-1 text-sm">
              {totalsByCategory.map(([cat, amount]) => (
                <li key={cat} className="flex items-center justify-between text-ink-secondary">
                  <span>{cat}</span>
                  <span>{formatRupees(amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-ink-muted">Loading expenses…</p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-hairline bg-surface-2">
          <table className="w-full text-sm">
            <thead className="bg-surface-1 text-left text-xs uppercase tracking-wide text-ink-muted">
              <tr>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Category</th>
                <th className="px-3 py-2">Description</th>
                <th className="px-3 py-2">Amount</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {expenses.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-ink-faint">
                    No expenses recorded for this filter.
                  </td>
                </tr>
              )}
              {expenses.map((exp) =>
                editingId === exp.id ? (
                  <EditExpenseRow
                    key={exp.id}
                    restaurantSlug={slug}
                    expense={exp}
                    categories={activeCategories}
                    branches={branches}
                    onDone={() => {
                      setEditingId(null);
                      load();
                    }}
                    onCancel={() => setEditingId(null)}
                  />
                ) : (
                  <ExpenseRow
                    key={exp.id}
                    slug={slug}
                    expense={exp}
                    canManage={canManage}
                    canApprove={canApprove}
                    canPay={canPay}
                    onEdit={() => setEditingId(exp.id)}
                    onChanged={load}
                  />
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ExpenseRow({
  slug,
  expense,
  canManage,
  canApprove,
  canPay,
  onEdit,
  onChanged,
}: {
  slug: string;
  expense: Expense;
  canManage: boolean;
  canApprove: boolean;
  canPay: boolean;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const dateSystem = useDateSystem();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showReject, setShowReject] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [showPay, setShowPay] = useState(false);
  const [payMethod, setPayMethod] = useState<ExpensePaymentMethod>("cash");

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/expenses/${expense.id}/approve`, {});
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not approve.");
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    setBusy(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/expenses/${expense.id}/reject`, { reason: rejectReason });
      setShowReject(false);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reject.");
    } finally {
      setBusy(false);
    }
  }

  async function pay() {
    setBusy(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/expenses/${expense.id}/pay`, { paymentMethod: payMethod });
      setShowPay(false);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not record the payment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <tr className={`border-t border-hairline/60 ${expense.isVoided ? "opacity-50" : ""}`}>
        <td className="px-3 py-2 text-ink-muted">
          {formatDate(`${expense.expenseDate}T00:00:00`, dateSystem)}
        </td>
        <td className="px-3 py-2">{expense.categoryName}</td>
        <td className="px-3 py-2 text-ink">
          {expense.description}
          {expense.branchName && (
            <span className="ml-2 text-xs text-ink-faint">· {expense.branchName}</span>
          )}
          {expense.isVoided && <span className="ml-2 text-xs text-ink-faint">(voided)</span>}
          {expense.note && <p className="text-xs text-ink-faint">{expense.note}</p>}
          {expense.status === "rejected" && expense.rejectionReason && (
            <p className="text-xs text-red-400">Rejected: {expense.rejectionReason}</p>
          )}
          {expense.status === "paid" && expense.paymentMethod && (
            <p className="text-xs text-ink-faint">
              Paid via {EXPENSE_PAYMENT_METHOD_LABELS[expense.paymentMethod]}
            </p>
          )}
          {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
        </td>
        <td className="px-3 py-2 font-medium">{formatRupees(expense.amountInPaisa)}</td>
        <td className="px-3 py-2">
          <StatusBadge status={expense.status} />
        </td>
        <td className="px-3 py-2 text-right">
          <div className="flex flex-wrap justify-end gap-2">
            {expense.status === "pending_approval" && canApprove && (
              <>
                <button disabled={busy} onClick={approve} className="text-xs font-medium text-emerald-400 hover:underline">
                  Approve
                </button>
                <button disabled={busy} onClick={() => setShowReject((v) => !v)} className="text-xs font-medium text-red-400 hover:underline">
                  Reject
                </button>
              </>
            )}
            {expense.status === "approved" && canPay && (
              <button disabled={busy} onClick={() => setShowPay((v) => !v)} className="text-xs font-medium text-emerald-400 hover:underline">
                Mark paid
              </button>
            )}
            {canManage && (
              <button onClick={onEdit} className="text-xs font-medium text-orange-400 hover:underline">
                Edit
              </button>
            )}
          </div>
        </td>
      </tr>
      {showReject && (
        <tr className="border-t border-hairline/60 bg-red-500/15">
          <td colSpan={6} className="px-3 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="Reason for rejecting"
                className="input flex-1"
              />
              <button disabled={busy || !rejectReason.trim()} onClick={reject} className="btn-primary">
                {busy ? "Rejecting…" : "Confirm reject"}
              </button>
              <button disabled={busy} onClick={() => setShowReject(false)} className="btn-secondary">
                Cancel
              </button>
            </div>
          </td>
        </tr>
      )}
      {showPay && (
        <tr className="border-t border-hairline/60 bg-emerald-500/15">
          <td colSpan={6} className="px-3 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <select value={payMethod} onChange={(e) => setPayMethod(e.target.value as ExpensePaymentMethod)} className="input !w-auto">
                {EXPENSE_PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {EXPENSE_PAYMENT_METHOD_LABELS[m]}
                  </option>
                ))}
              </select>
              <button disabled={busy} onClick={pay} className="btn-primary">
                {busy ? "Recording…" : `Confirm paid via ${EXPENSE_PAYMENT_METHOD_LABELS[payMethod]}`}
              </button>
              <button disabled={busy} onClick={() => setShowPay(false)} className="btn-secondary">
                Cancel
              </button>
            </div>
            <p className="mt-2 text-xs text-ink-muted">
              Only confirm this once the money has actually gone out — there&apos;s no automatic
              verification for eSewa/Khalti/bank transfers sent from the dashboard, the same as cash.
            </p>
          </td>
        </tr>
      )}
    </>
  );
}

function AddExpenseForm({
  slug,
  categories,
  branches,
  canPay,
  onAdded,
}: {
  slug: string;
  categories: ExpenseCategory[];
  branches: Branch[];
  canPay: boolean;
  onAdded: () => void;
}) {
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? "");
  const [branchId, setBranchId] = useState("");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [expenseDate, setExpenseDate] = useState(todayIso());
  const [note, setNote] = useState("");
  const [markPaidNow, setMarkPaidNow] = useState(canPay);
  const [paymentMethod, setPaymentMethod] = useState<ExpensePaymentMethod>("cash");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dateSystem = useDateSystem();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/expenses`, {
        categoryId,
        amount: Number(amount),
        description,
        expenseDate,
        note: note || undefined,
        branchId: branchId || undefined,
        paymentMethod: canPay && markPaidNow ? paymentMethod : undefined,
      });
      setAmount("");
      setDescription("");
      setNote("");
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add expense.");
    } finally {
      setSaving(false);
    }
  }

  if (categories.length === 0) {
    return (
      <p className="rounded-2xl border border-hairline bg-surface-2 p-4 text-sm text-ink-muted">
        No expense categories yet — add one under &quot;Categories&quot; first.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="rounded-2xl border border-hairline bg-surface-2 p-4">
      {error && <p className="mb-3 rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-400">{error}</p>}
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-sm">
          <span className="mb-1 block text-ink-secondary">Category</span>
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="input">
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-ink-secondary">Amount (Rs)</span>
          <input
            required
            type="number"
            min={0.01}
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="input"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-ink-secondary">Date</span>
          <input
            required
            type="date"
            value={expenseDate}
            onChange={(e) => setExpenseDate(e.target.value)}
            className="input"
          />
          {dateSystem === "BS" && (
            <span className="mt-1 block text-xs text-ink-faint">{formatBsHint(expenseDate)}</span>
          )}
        </label>
        <label className="text-sm sm:col-span-2">
          <span className="mb-1 block text-ink-secondary">Description</span>
          <input
            required
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="input"
            placeholder="e.g. Electricity bill for Shrawan"
          />
        </label>
        {branches.length > 1 && (
          <label className="text-sm">
            <span className="mb-1 block text-ink-secondary">Branch (optional)</span>
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
        <label className="text-sm sm:col-span-2">
          <span className="mb-1 block text-ink-secondary">Note (optional)</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} className="input" />
        </label>
      </div>

      {canPay && (
        <div className="mt-3 rounded-xl border border-hairline bg-surface-1 p-3">
          <label className="flex items-center gap-2 text-sm text-ink-secondary">
            <input
              type="checkbox"
              checked={markPaidNow}
              onChange={(e) => setMarkPaidNow(e.target.checked)}
            />
            This has already been paid — record it as paid now
          </label>
          {markPaidNow && (
            <label className="mt-2 block text-sm">
              <span className="mb-1 block text-ink-secondary">Payment method</span>
              <select
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value as ExpensePaymentMethod)}
                className="input !w-auto"
              >
                {EXPENSE_PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {EXPENSE_PAYMENT_METHOD_LABELS[m]}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!markPaidNow && (
            <p className="mt-1 text-xs text-ink-muted">
              Left unchecked, this is submitted as approved and awaiting payment.
            </p>
          )}
        </div>
      )}
      {!canPay && (
        <p className="mt-3 text-xs text-ink-muted">
          This will be submitted for approval — a manager, accountant, or the owner will review it.
        </p>
      )}

      <button disabled={saving} className="btn-primary mt-3">
        {saving ? "Adding…" : "Add expense"}
      </button>
    </form>
  );
}

function EditExpenseRow({
  restaurantSlug,
  expense,
  categories,
  branches,
  onDone,
  onCancel,
}: {
  restaurantSlug: string;
  expense: Expense;
  categories: ExpenseCategory[];
  branches: Branch[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [categoryId, setCategoryId] = useState(expense.categoryId);
  const [branchId, setBranchId] = useState(expense.branchId ?? "");
  const [amount, setAmount] = useState(String(expense.amountInPaisa / 100));
  const [description, setDescription] = useState(expense.description);
  const [expenseDate, setExpenseDate] = useState(expense.expenseDate);
  const [note, setNote] = useState(expense.note ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dateSystem = useDateSystem();
  const locked = expense.status === "paid"; // amount/category are financial history once paid

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await apiPatch(`${base(restaurantSlug)}/expenses/${expense.id}`, {
        ...(locked ? {} : { categoryId, amount: Number(amount) }),
        description,
        expenseDate,
        note: note || undefined,
        branchId: branchId || null,
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update expense.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleVoid() {
    setSaving(true);
    setError(null);
    try {
      await apiPatch(`${base(restaurantSlug)}/expenses/${expense.id}`, {
        isVoided: !expense.isVoided,
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not void expense.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <tr className="border-t border-hairline/60 bg-surface-1">
      <td colSpan={6} className="px-3 py-3">
        {error && <p className="mb-2 rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-400">{error}</p>}
        {locked && (
          <p className="mb-2 text-xs text-amber-400">
            This expense is already paid — the amount and category are locked. Void it and record a
            new one if either was wrong.
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-5">
          <select
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            className="input"
            disabled={locked}
          >
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <input
            type="number"
            min={0.01}
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="input"
            disabled={locked}
          />
          <div>
            <input
              type="date"
              value={expenseDate}
              onChange={(e) => setExpenseDate(e.target.value)}
              className="input"
            />
            {dateSystem === "BS" && (
              <span className="mt-1 block text-xs text-ink-faint">{formatBsHint(expenseDate)}</span>
            )}
          </div>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="input sm:col-span-2"
          />
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note (optional)"
            className="input sm:col-span-2"
          />
          {branches.length > 1 && (
            <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className="input">
              <option value="">All branches</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button disabled={saving} onClick={save} className="btn-primary">
            {saving ? "Saving…" : "Save changes"}
          </button>
          <button disabled={saving} onClick={onCancel} className="btn-secondary">
            Cancel
          </button>
          {expense.status === "paid" && (
            <button
              disabled={saving}
              onClick={toggleVoid}
              className="ml-auto text-xs font-medium text-red-400 hover:underline"
            >
              {expense.isVoided ? "Un-void this entry" : "Void this entry"}
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

function CategoriesPanel({
  slug,
  categories,
  onChanged,
}: {
  slug: string;
  categories: ExpenseCategory[];
  onChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/expense-categories`, { name });
      setName("");
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add category.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(cat: ExpenseCategory) {
    try {
      await apiPatch(`${base(slug)}/expense-categories/${cat.id}`, { isActive: !cat.isActive });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update category.");
    }
  }

  return (
    <div className="rounded-2xl border border-hairline bg-surface-2 p-4">
      {error && <p className="mb-3 rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-400">{error}</p>}
      <form onSubmit={add} className="mb-3 flex gap-2">
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New category name"
          className="input flex-1"
        />
        <button disabled={saving} className="btn-primary">
          {saving ? "Adding…" : "Add category"}
        </button>
      </form>
      <div className="flex flex-wrap gap-2">
        {categories.map((c) => (
          <button
            key={c.id}
            onClick={() => toggleActive(c)}
            className={`rounded-full border px-3 py-1 text-xs ${
              c.isActive
                ? "border-hairline text-ink-secondary"
                : "border-hairline bg-surface-1 text-ink-faint line-through"
            }`}
          >
            {c.name}
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-ink-faint">
        Click a category to activate/deactivate it. A category used by an existing expense can&apos;t
        be deleted, only deactivated (it still shows on old expenses, just hidden from new ones).
      </p>
    </div>
  );
}
