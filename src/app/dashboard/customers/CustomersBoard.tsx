"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPost, apiPatch, ApiError } from "@/lib/api-client";
import { tierForPoints, pointsToNextTier, LOYALTY_TIERS } from "@/lib/loyalty-tiers";
import { isBirthdayToday } from "@/lib/loyalty-birthday";
import { VISIT_STREAK_MILESTONE_INTERVAL } from "@/lib/loyalty-streaks";

type Customer = {
  id: string;
  phone: string;
  fullName: string;
  email: string | null;
  dateOfBirth: string | null;
  currentVisitStreak: number;
  longestVisitStreak: number;
  notes: string | null;
  loyaltyPointsBalance: number;
  lifetimePointsEarned: number;
  totalOrdersCount: number;
  totalSpentInPaisa: number;
  isActive: boolean;
  createdAt: string;
};

type OrderSummary = {
  id: string;
  orderNumber: string;
  status: string;
  totalInPaisa: number;
  placedAt: string;
};

type LoyaltyLedgerEntry = {
  id: string;
  type: "earn" | "redeem" | "adjustment";
  pointsDelta: number;
  note: string | null;
  createdAt: string;
};

function base(slug: string) {
  return `/api/restaurants/${slug}`;
}

function formatRupees(paisa: number) {
  return `Rs ${(paisa / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
}

function tierBadgeClass(tier: string) {
  switch (tier) {
    case "Platinum":
      return "bg-neutral-900 text-white";
    case "Gold":
      return "bg-amber-100 text-amber-800";
    case "Silver":
      return "bg-neutral-200 text-neutral-700";
    default:
      return "bg-orange-100 text-orange-800";
  }
}

export function CustomersBoard({
  slug,
  canManageCustomers,
}: {
  slug: string;
  canManageCustomers: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (!canManageCustomers) {
    return (
      <p className="text-sm text-neutral-400">
        Your role doesn&apos;t have access to the customer CRM.
      </p>
    );
  }

  if (selectedId) {
    return (
      <CustomerDetail slug={slug} customerId={selectedId} onBack={() => setSelectedId(null)} />
    );
  }

  return <CustomerList slug={slug} onSelect={setSelectedId} />;
}

// ---------------------------------------------------------------------------
// List / search
// ---------------------------------------------------------------------------

function CustomerList({
  slug,
  onSelect,
}: {
  slug: string;
  onSelect: (id: string) => void;
}) {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  async function load(query: string) {
    setLoading(true);
    try {
      const url = query
        ? `${base(slug)}/customers?q=${encodeURIComponent(query)}`
        : `${base(slug)}/customers`;
      const res = await apiGet<{ customers: Customer[] }>(url);
      setCustomers(res.customers);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load customers.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const handle = setTimeout(() => load(q), 250);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, q]);

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by name or phone…"
          className="input sm:max-w-xs"
        />
        <button onClick={() => setShowAdd((v) => !v)} className="btn-primary">
          {showAdd ? "Cancel" : "+ Add customer"}
        </button>
      </div>

      {showAdd && (
        <AddCustomerForm
          slug={slug}
          onAdded={() => {
            setShowAdd(false);
            load(q);
          }}
        />
      )}

      {loading ? (
        <p className="text-sm text-neutral-500">Loading customers…</p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Phone</th>
                <th className="px-3 py-2">Tier</th>
                <th className="px-3 py-2">Points</th>
                <th className="px-3 py-2">Streak</th>
                <th className="px-3 py-2">Orders</th>
                <th className="px-3 py-2">Total spent</th>
              </tr>
            </thead>
            <tbody>
              {customers.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-neutral-400">
                    No customers yet.
                  </td>
                </tr>
              )}
              {customers.map((c) => {
                const tier = tierForPoints(c.lifetimePointsEarned);
                const birthday = isBirthdayToday(c.dateOfBirth, new Date().toISOString().slice(0, 10));
                return (
                  <tr
                    key={c.id}
                    onClick={() => onSelect(c.id)}
                    className="cursor-pointer border-t border-neutral-100 hover:bg-neutral-50"
                  >
                    <td className="px-3 py-2 font-medium text-neutral-900">
                      {c.fullName}
                      {birthday && (
                        <span
                          title="Birthday today"
                          className="ml-2 rounded-full bg-pink-100 px-1.5 py-0.5 text-[10px] font-medium text-pink-700"
                        >
                          Birthday
                        </span>
                      )}
                      {!c.isActive && (
                        <span className="ml-2 text-xs text-neutral-400">(inactive)</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-neutral-500">{c.phone}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${tierBadgeClass(tier)}`}
                      >
                        {tier}
                      </span>
                    </td>
                    <td className="px-3 py-2">{c.loyaltyPointsBalance}</td>
                    <td className="px-3 py-2 text-neutral-500">
                      {c.currentVisitStreak > 0 ? `${c.currentVisitStreak}🔥` : "—"}
                    </td>
                    <td className="px-3 py-2">{c.totalOrdersCount}</td>
                    <td className="px-3 py-2">{formatRupees(c.totalSpentInPaisa)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AddCustomerForm({ slug, onAdded }: { slug: string; onAdded: () => void }) {
  const [phone, setPhone] = useState("");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/customers`, {
        phone,
        fullName,
        email: email || undefined,
        dateOfBirth: dateOfBirth || undefined,
      });
      setPhone("");
      setFullName("");
      setEmail("");
      setDateOfBirth("");
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add customer.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded-2xl border border-neutral-200 bg-white p-4">
      {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div className="grid gap-3 sm:grid-cols-4">
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
          <span className="mb-1 block text-neutral-600">Full name</span>
          <input
            required
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            className="input"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Email (optional)</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="input"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Birthday (optional)</span>
          <input
            type="date"
            value={dateOfBirth}
            onChange={(e) => setDateOfBirth(e.target.value)}
            className="input"
          />
        </label>
      </div>
      <button disabled={saving} className="btn-primary mt-3">
        {saving ? "Adding…" : "Add customer"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------------

function CustomerDetail({
  slug,
  customerId,
  onBack,
}: {
  slug: string;
  customerId: string;
  onBack: () => void;
}) {
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [ledger, setLedger] = useState<LoyaltyLedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAdjust, setShowAdjust] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const res = await apiGet<{
        customer: Customer;
        recentOrders: OrderSummary[];
        loyaltyLedger: LoyaltyLedgerEntry[];
      }>(`${base(slug)}/customers/${customerId}`);
      setCustomer(res.customer);
      setOrders(res.recentOrders);
      setLedger(res.loyaltyLedger);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load customer.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, customerId]);

  async function toggleActive() {
    if (!customer) return;
    try {
      await apiPatch(`${base(slug)}/customers/${customerId}`, { isActive: !customer.isActive });
      load();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not update customer.");
    }
  }

  if (loading) return <p className="text-sm text-neutral-500">Loading…</p>;
  if (error || !customer) {
    return (
      <div className="space-y-3">
        <BackButton onBack={onBack} />
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error ?? "Customer not found."}
        </p>
      </div>
    );
  }

  const tier = tierForPoints(customer.lifetimePointsEarned);
  const toNext = pointsToNextTier(customer.lifetimePointsEarned);
  const birthday = isBirthdayToday(customer.dateOfBirth, new Date().toISOString().slice(0, 10));

  return (
    <div className="space-y-4">
      <BackButton onBack={onBack} />

      <div className="rounded-2xl border border-neutral-200 bg-white p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-neutral-900">
              {customer.fullName}
              {birthday && (
                <span className="ml-2 rounded-full bg-pink-100 px-2 py-0.5 text-xs font-medium text-pink-700">
                  🎂 Happy birthday!
                </span>
              )}
              {!customer.isActive && (
                <span className="ml-2 text-sm font-normal text-neutral-400">(inactive)</span>
              )}
            </h2>
            <p className="text-sm text-neutral-500">
              {customer.phone}
              {customer.email ? ` · ${customer.email}` : ""}
            </p>
          </div>
          <span className={`rounded-full px-3 py-1 text-sm font-medium ${tierBadgeClass(tier)}`}>
            {tier} tier
          </span>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Points balance" value={String(customer.loyaltyPointsBalance)} />
          <Stat label="Lifetime points" value={String(customer.lifetimePointsEarned)} />
          <Stat label="Orders" value={String(customer.totalOrdersCount)} />
          <Stat label="Total spent" value={formatRupees(customer.totalSpentInPaisa)} />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat
            label="Visit streak"
            value={
              customer.currentVisitStreak > 0
                ? `${customer.currentVisitStreak} visit${customer.currentVisitStreak === 1 ? "" : "s"}`
                : "—"
            }
          />
          <Stat
            label="Longest streak"
            value={
              customer.longestVisitStreak > 0
                ? `${customer.longestVisitStreak} visit${customer.longestVisitStreak === 1 ? "" : "s"}`
                : "—"
            }
          />
        </div>
        <p className="mt-2 text-xs text-neutral-400">
          {toNext !== null
            ? `${toNext} more lifetime points to reach ${
                LOYALTY_TIERS[LOYALTY_TIERS.findIndex((t) => t.name === tier) + 1]?.name
              } tier.`
            : "Highest tier reached."}
          {` Every ${VISIT_STREAK_MILESTONE_INTERVAL}th visit within a week of the last earns a streak bonus.`}
        </p>
        {customer.notes && <p className="mt-3 text-sm text-neutral-600">Notes: {customer.notes}</p>}

        <BirthdayEditor
          slug={slug}
          customerId={customerId}
          dateOfBirth={customer.dateOfBirth}
          onSaved={load}
        />

        <div className="mt-4 flex flex-wrap gap-2">
          <button onClick={() => setShowAdjust((v) => !v)} className="btn-secondary">
            {showAdjust ? "Cancel" : "Adjust points"}
          </button>
          <button onClick={toggleActive} className="text-xs font-medium text-orange-700 hover:underline">
            {customer.isActive ? "Deactivate customer" : "Reactivate customer"}
          </button>
        </div>

        {showAdjust && (
          <AdjustPointsForm
            slug={slug}
            customerId={customerId}
            balance={customer.loyaltyPointsBalance}
            onAdjusted={() => {
              setShowAdjust(false);
              load();
            }}
          />
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-2xl border border-neutral-200 bg-white p-4">
          <h3 className="mb-2 text-sm font-semibold text-neutral-900">Recent orders</h3>
          {orders.length === 0 ? (
            <p className="text-sm text-neutral-400">No orders yet.</p>
          ) : (
            <ul className="divide-y divide-neutral-100 text-sm">
              {orders.map((o) => (
                <li key={o.id} className="flex items-center justify-between py-2">
                  <span>
                    #{o.orderNumber} <span className="text-neutral-400">({o.status})</span>
                  </span>
                  <span className="text-neutral-600">{formatRupees(o.totalInPaisa)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-2xl border border-neutral-200 bg-white p-4">
          <h3 className="mb-2 text-sm font-semibold text-neutral-900">Loyalty ledger</h3>
          {ledger.length === 0 ? (
            <p className="text-sm text-neutral-400">No loyalty activity yet.</p>
          ) : (
            <ul className="divide-y divide-neutral-100 text-sm">
              {ledger.map((t) => (
                <li key={t.id} className="flex items-center justify-between py-2">
                  <span>
                    <span className="capitalize">{t.type}</span>
                    {t.note ? <span className="text-neutral-400"> — {t.note}</span> : null}
                  </span>
                  <span className={t.pointsDelta >= 0 ? "text-green-700" : "text-red-700"}>
                    {t.pointsDelta >= 0 ? "+" : ""}
                    {t.pointsDelta}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Small inline editor for the one field that drives the birthday bonus —
 * mirrors KotSettingsPanel's "edit-in-place, no separate page" shape for a
 * single field that doesn't warrant its own form section.
 */
function BirthdayEditor({
  slug,
  customerId,
  dateOfBirth,
  onSaved,
}: {
  slug: string;
  customerId: string;
  dateOfBirth: string | null;
  onSaved: () => void;
}) {
  const [value, setValue] = useState(dateOfBirth ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setValue(dateOfBirth ?? "");
  }, [dateOfBirth]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await apiPatch(`${base(slug)}/customers/${customerId}`, { dateOfBirth: value });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save birthday.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-3 flex flex-wrap items-end gap-2">
      <label className="text-sm">
        <span className="mb-1 block text-neutral-600">Birthday</span>
        <input
          type="date"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="input"
        />
      </label>
      <button
        onClick={save}
        disabled={saving || value === (dateOfBirth ?? "")}
        className="btn-secondary text-xs disabled:opacity-50"
      >
        {saving ? "Saving…" : "Save birthday"}
      </button>
      {error && <p className="text-xs text-red-700">{error}</p>}
      {!dateOfBirth && (
        <p className="w-full text-xs text-neutral-400">
          Add their birthday to enable an automatic yearly bonus.
        </p>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-neutral-50 px-3 py-2">
      <p className="text-xs text-neutral-500">{label}</p>
      <p className="text-base font-semibold text-neutral-900">{value}</p>
    </div>
  );
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <button onClick={onBack} className="text-sm font-medium text-orange-700 hover:underline">
      ← Back to customers
    </button>
  );
}

function AdjustPointsForm({
  slug,
  customerId,
  balance,
  onAdjusted,
}: {
  slug: string;
  customerId: string;
  balance: number;
  onAdjusted: () => void;
}) {
  const [points, setPoints] = useState("");
  const [direction, setDirection] = useState<"add" | "redeem">("add");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/customers/${customerId}/loyalty/adjust`, {
        points: Number(points),
        direction,
        reason,
      });
      setPoints("");
      setReason("");
      onAdjusted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not adjust points.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-4 rounded-xl border border-neutral-200 bg-neutral-50 p-3">
      {error && <p className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <p className="mb-2 text-xs text-neutral-500">Current balance: {balance} points</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Direction</span>
          <select
            value={direction}
            onChange={(e) => setDirection(e.target.value as "add" | "redeem")}
            className="input"
          >
            <option value="add">Add (goodwill credit)</option>
            <option value="redeem">Redeem</option>
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Points</span>
          <input
            required
            type="number"
            min={1}
            value={points}
            onChange={(e) => setPoints(e.target.value)}
            className="input"
          />
        </label>
        <label className="text-sm sm:col-span-1">
          <span className="mb-1 block text-neutral-600">Reason</span>
          <input required value={reason} onChange={(e) => setReason(e.target.value)} className="input" />
        </label>
      </div>
      <button disabled={saving} className="btn-primary mt-3">
        {saving ? "Saving…" : "Apply adjustment"}
      </button>
    </form>
  );
}
