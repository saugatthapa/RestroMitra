"use client";

import { useEffect, useMemo, useState } from "react";
import { apiGet, apiPost, apiPatch, ApiError } from "@/lib/api-client";
import { EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABELS, type ExpenseCategory } from "@/lib/expense-categories";

type Expense = {
  id: string;
  category: ExpenseCategory;
  amountInPaisa: number;
  description: string;
  expenseDate: string;
  note: string | null;
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
  return new Date().toISOString().slice(0, 10);
}

export function ExpensesBoard({
  slug,
  canManageExpenses,
}: {
  slug: string;
  canManageExpenses: boolean;
}) {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [categoryFilter, setCategoryFilter] = useState<ExpenseCategory | "">("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (categoryFilter) params.set("category", categoryFilter);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const qs = params.toString();
      const res = await apiGet<{ expenses: Expense[] }>(
        `${base(slug)}/expenses${qs ? `?${qs}` : ""}`,
      );
      setExpenses(res.expenses);
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
  }, [slug, categoryFilter, from, to]);

  const total = useMemo(
    () => expenses.reduce((sum, e) => sum + e.amountInPaisa, 0),
    [expenses],
  );

  const totalsByCategory = useMemo(() => {
    const map = new Map<ExpenseCategory, number>();
    for (const e of expenses) {
      map.set(e.category, (map.get(e.category) ?? 0) + e.amountInPaisa);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [expenses]);

  if (!canManageExpenses) {
    return (
      <p className="text-sm text-neutral-400">
        Your role doesn&apos;t have access to expense tracking.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-neutral-200 bg-white p-4">
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Category</span>
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value as ExpenseCategory | "")}
            className="input !w-auto"
          >
            <option value="">All categories</option>
            {EXPENSE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {EXPENSE_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">From</span>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="input !w-auto" />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">To</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="input !w-auto" />
        </label>
        <div className="ml-auto">
          <button onClick={() => setShowAdd((v) => !v)} className="btn-primary">
            {showAdd ? "Cancel" : "+ Add expense"}
          </button>
        </div>
      </div>

      {showAdd && (
        <AddExpenseForm
          slug={slug}
          onAdded={() => {
            setShowAdd(false);
            load();
          }}
        />
      )}

      <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
        <div className="rounded-2xl border border-neutral-200 bg-white p-4">
          <p className="text-xs text-neutral-500">Total (filtered)</p>
          <p className="text-2xl font-semibold text-neutral-900">{formatRupees(total)}</p>
          {totalsByCategory.length > 0 && (
            <ul className="mt-3 space-y-1 text-sm">
              {totalsByCategory.map(([cat, amount]) => (
                <li key={cat} className="flex items-center justify-between text-neutral-600">
                  <span>{EXPENSE_CATEGORY_LABELS[cat]}</span>
                  <span>{formatRupees(amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-neutral-500">Loading expenses…</p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Category</th>
                <th className="px-3 py-2">Description</th>
                <th className="px-3 py-2">Amount</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {expenses.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-neutral-400">
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
                    onDone={() => {
                      setEditingId(null);
                      load();
                    }}
                    onCancel={() => setEditingId(null)}
                  />
                ) : (
                  <ExpenseRow
                    key={exp.id}
                    expense={exp}
                    onEdit={() => setEditingId(exp.id)}
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

function ExpenseRow({ expense, onEdit }: { expense: Expense; onEdit: () => void }) {
  return (
    <tr className={`border-t border-neutral-100 ${expense.isVoided ? "opacity-50" : ""}`}>
      <td className="px-3 py-2 text-neutral-500">{expense.expenseDate}</td>
      <td className="px-3 py-2">{EXPENSE_CATEGORY_LABELS[expense.category]}</td>
      <td className="px-3 py-2 text-neutral-900">
        {expense.description}
        {expense.isVoided && <span className="ml-2 text-xs text-neutral-400">(voided)</span>}
        {expense.note && <p className="text-xs text-neutral-400">{expense.note}</p>}
      </td>
      <td className="px-3 py-2 font-medium">{formatRupees(expense.amountInPaisa)}</td>
      <td className="px-3 py-2 text-right">
        <button onClick={onEdit} className="text-xs font-medium text-orange-700 hover:underline">
          Edit
        </button>
      </td>
    </tr>
  );
}

function AddExpenseForm({ slug, onAdded }: { slug: string; onAdded: () => void }) {
  const [category, setCategory] = useState<ExpenseCategory>("supplies");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [expenseDate, setExpenseDate] = useState(todayIso());
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/expenses`, {
        category,
        amount: Number(amount),
        description,
        expenseDate,
        note: note || undefined,
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

  return (
    <form onSubmit={submit} className="rounded-2xl border border-neutral-200 bg-white p-4">
      {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Category</span>
          <select value={category} onChange={(e) => setCategory(e.target.value as ExpenseCategory)} className="input">
            {EXPENSE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {EXPENSE_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Amount (Rs)</span>
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
          <span className="mb-1 block text-neutral-600">Date</span>
          <input
            required
            type="date"
            value={expenseDate}
            onChange={(e) => setExpenseDate(e.target.value)}
            className="input"
          />
        </label>
        <label className="text-sm sm:col-span-2">
          <span className="mb-1 block text-neutral-600">Description</span>
          <input
            required
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="input"
            placeholder="e.g. Electricity bill for Shrawan"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Note (optional)</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} className="input" />
        </label>
      </div>
      <button disabled={saving} className="btn-primary mt-3">
        {saving ? "Adding…" : "Add expense"}
      </button>
    </form>
  );
}

function EditExpenseRow({
  restaurantSlug,
  expense,
  onDone,
  onCancel,
}: {
  restaurantSlug: string;
  expense: Expense;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [category, setCategory] = useState<ExpenseCategory>(expense.category);
  const [amount, setAmount] = useState(String(expense.amountInPaisa / 100));
  const [description, setDescription] = useState(expense.description);
  const [expenseDate, setExpenseDate] = useState(expense.expenseDate);
  const [note, setNote] = useState(expense.note ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await apiPatch(`${base(restaurantSlug)}/expenses/${expense.id}`, {
        category,
        amount: Number(amount),
        description,
        expenseDate,
        note: note || undefined,
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
    <tr className="border-t border-neutral-100 bg-neutral-50">
      <td colSpan={5} className="px-3 py-3">
        {error && <p className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <div className="grid gap-3 sm:grid-cols-5">
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as ExpenseCategory)}
            className="input"
          >
            {EXPENSE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {EXPENSE_CATEGORY_LABELS[c]}
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
          />
          <input
            type="date"
            value={expenseDate}
            onChange={(e) => setExpenseDate(e.target.value)}
            className="input"
          />
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
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button disabled={saving} onClick={save} className="btn-primary">
            {saving ? "Saving…" : "Save changes"}
          </button>
          <button disabled={saving} onClick={onCancel} className="btn-secondary">
            Cancel
          </button>
          <button
            disabled={saving}
            onClick={toggleVoid}
            className="ml-auto text-xs font-medium text-red-700 hover:underline"
          >
            {expense.isVoided ? "Un-void this entry" : "Void this entry"}
          </button>
        </div>
      </td>
    </tr>
  );
}
