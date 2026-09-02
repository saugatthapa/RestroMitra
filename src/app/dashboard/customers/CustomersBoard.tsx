"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPost, apiPatch, ApiError } from "@/lib/api-client";
import { tierForPoints, pointsToNextTier, LOYALTY_TIERS } from "@/lib/loyalty-tiers";
import { isBirthdayToday } from "@/lib/loyalty-birthday";
import { VISIT_STREAK_MILESTONE_INTERVAL } from "@/lib/loyalty-streaks";
import { useDateSystem } from "@/lib/date-system";
import { formatBsHint } from "@/lib/nepali-date";
import { localDateIso } from "@/lib/local-date";

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
  creditLimitInPaisa: number | null;
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

// Commercial Launch Phase B.5 — Customer Credit. Mirrors the shape
// AccountBooksBoard.tsx's own LedgerEntry type uses — same API response
// shape (listLedgerEntries), just the fields this view actually reads.
type CreditLedgerEntry = {
  id: string;
  entryDate: string;
  direction: "credit" | "debit";
  category: string;
  amountInPaisa: number;
  settledAmountInPaisa: number;
  dueStatus: "none" | "outstanding" | "settled";
  description: string;
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
      return "bg-surface-0 text-white";
    case "Gold":
      return "bg-amber-500/20 text-amber-300";
    case "Silver":
      return "bg-surface-3 text-ink-secondary";
    default:
      return "bg-orange-500/20 text-orange-300";
  }
}

export function CustomersBoard({
  slug,
  canManageCustomers,
  canManageAccountBooks,
}: {
  slug: string;
  canManageCustomers: boolean;
  canManageAccountBooks: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (!canManageCustomers) {
    return (
      <p className="text-sm text-ink-faint">
        Your role doesn&apos;t have access to the customer CRM.
      </p>
    );
  }

  if (selectedId) {
    return (
      <CustomerDetail
        slug={slug}
        customerId={selectedId}
        canManageAccountBooks={canManageAccountBooks}
        onBack={() => setSelectedId(null)}
      />
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
      {error && <p className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-400">{error}</p>}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by name or phone…"
          className="input sm:max-w-xs"
        />
        <div className="flex gap-2">
          <a href={`${base(slug)}/customers/export`} download className="btn-secondary text-xs">
            Export CSV
          </a>
          <button onClick={() => setShowAdd((v) => !v)} className="btn-primary">
            {showAdd ? "Cancel" : "+ Add customer"}
          </button>
        </div>
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
        <p className="text-sm text-ink-muted">Loading customers…</p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-hairline bg-surface-2">
          <table className="w-full text-sm">
            <thead className="bg-surface-1 text-left text-xs uppercase tracking-wide text-ink-muted">
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
                  <td colSpan={7} className="px-3 py-6 text-center text-ink-faint">
                    No customers yet.
                  </td>
                </tr>
              )}
              {customers.map((c) => {
                const tier = tierForPoints(c.lifetimePointsEarned);
                const birthday = isBirthdayToday(c.dateOfBirth, localDateIso());
                return (
                  <tr
                    key={c.id}
                    onClick={() => onSelect(c.id)}
                    className="cursor-pointer border-t border-hairline/60 hover:bg-surface-1"
                  >
                    <td className="px-3 py-2 font-medium text-ink">
                      {c.fullName}
                      {birthday && (
                        <span
                          title="Birthday today"
                          className="ml-2 rounded-full bg-pink-500/20 px-1.5 py-0.5 text-[10px] font-medium text-pink-400"
                        >
                          Birthday
                        </span>
                      )}
                      {!c.isActive && (
                        <span className="ml-2 text-xs text-ink-faint">(inactive)</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-ink-muted">{c.phone}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${tierBadgeClass(tier)}`}
                      >
                        {tier}
                      </span>
                    </td>
                    <td className="px-3 py-2">{c.loyaltyPointsBalance}</td>
                    <td className="px-3 py-2 text-ink-muted">
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
  const dateSystem = useDateSystem();

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
    <form onSubmit={submit} className="rounded-2xl border border-hairline bg-surface-2 p-4">
      {error && <p className="mb-3 rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-400">{error}</p>}
      <div className="grid gap-3 sm:grid-cols-4">
        <label className="text-sm">
          <span className="mb-1 block text-ink-secondary">Phone</span>
          <input
            required
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="input"
            placeholder="98XXXXXXXX"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-ink-secondary">Full name</span>
          <input
            required
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            className="input"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-ink-secondary">Email (optional)</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="input"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-ink-secondary">Birthday (optional)</span>
          <input
            type="date"
            value={dateOfBirth}
            onChange={(e) => setDateOfBirth(e.target.value)}
            className="input"
          />
          {dateSystem === "BS" && dateOfBirth && (
            <span className="mt-1 block text-xs text-ink-faint">{formatBsHint(dateOfBirth)}</span>
          )}
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
  canManageAccountBooks,
  onBack,
}: {
  slug: string;
  customerId: string;
  canManageAccountBooks: boolean;
  onBack: () => void;
}) {
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [ledger, setLedger] = useState<LoyaltyLedgerEntry[]>([]);
  const [outstandingCreditInPaisa, setOutstandingCreditInPaisa] = useState(0);
  const [creditLedger, setCreditLedger] = useState<CreditLedgerEntry[]>([]);
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
        outstandingCreditInPaisa: number;
        creditLedger: CreditLedgerEntry[];
      }>(`${base(slug)}/customers/${customerId}`);
      setCustomer(res.customer);
      setOrders(res.recentOrders);
      setLedger(res.loyaltyLedger);
      setOutstandingCreditInPaisa(res.outstandingCreditInPaisa);
      setCreditLedger(res.creditLedger);
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

  if (loading) return <p className="text-sm text-ink-muted">Loading…</p>;
  if (error || !customer) {
    return (
      <div className="space-y-3">
        <BackButton onBack={onBack} />
        <p className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-400">
          {error ?? "Customer not found."}
        </p>
      </div>
    );
  }

  const tier = tierForPoints(customer.lifetimePointsEarned);
  const toNext = pointsToNextTier(customer.lifetimePointsEarned);
  const birthday = isBirthdayToday(customer.dateOfBirth, localDateIso());

  return (
    <div className="space-y-4">
      <BackButton onBack={onBack} />

      <div className="rounded-2xl border border-hairline bg-surface-2 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-ink">
              {customer.fullName}
              {birthday && (
                <span className="ml-2 rounded-full bg-pink-500/20 px-2 py-0.5 text-xs font-medium text-pink-400">
                  🎂 Happy birthday!
                </span>
              )}
              {!customer.isActive && (
                <span className="ml-2 text-sm font-normal text-ink-faint">(inactive)</span>
              )}
            </h2>
            <p className="text-sm text-ink-muted">
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
        {(outstandingCreditInPaisa > 0 || customer.creditLimitInPaisa !== null) && (
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat
              label="Outstanding tab"
              value={formatRupees(outstandingCreditInPaisa)}
              tone={
                outstandingCreditInPaisa > 0 &&
                customer.creditLimitInPaisa !== null &&
                outstandingCreditInPaisa >= customer.creditLimitInPaisa
                  ? "warning"
                  : outstandingCreditInPaisa > 0
                    ? "info"
                    : undefined
              }
            />
            {customer.creditLimitInPaisa !== null && (
              <Stat label="Credit limit" value={formatRupees(customer.creditLimitInPaisa)} />
            )}
          </div>
        )}
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
        <p className="mt-2 text-xs text-ink-faint">
          {toNext !== null
            ? `${toNext} more lifetime points to reach ${
                LOYALTY_TIERS[LOYALTY_TIERS.findIndex((t) => t.name === tier) + 1]?.name
              } tier.`
            : "Highest tier reached."}
          {` Every ${VISIT_STREAK_MILESTONE_INTERVAL}th visit within a week of the last earns a streak bonus.`}
        </p>
        {customer.notes && <p className="mt-3 text-sm text-ink-secondary">Notes: {customer.notes}</p>}

        <BirthdayEditor
          slug={slug}
          customerId={customerId}
          dateOfBirth={customer.dateOfBirth}
          onSaved={load}
        />

        {canManageAccountBooks && (
          <CreditLimitEditor
            slug={slug}
            customerId={customerId}
            creditLimitInPaisa={customer.creditLimitInPaisa}
            onSaved={load}
          />
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          <button onClick={() => setShowAdjust((v) => !v)} className="btn-secondary">
            {showAdjust ? "Cancel" : "Adjust points"}
          </button>
          <button onClick={toggleActive} className="text-xs font-medium text-orange-400 hover:underline">
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
        <div className="rounded-2xl border border-hairline bg-surface-2 p-4">
          <h3 className="mb-2 text-sm font-semibold text-ink">Recent orders</h3>
          {orders.length === 0 ? (
            <p className="text-sm text-ink-faint">No orders yet.</p>
          ) : (
            <ul className="divide-y divide-hairline/60 text-sm">
              {orders.map((o) => (
                <li key={o.id} className="flex items-center justify-between py-2">
                  <span>
                    #{o.orderNumber} <span className="text-ink-faint">({o.status})</span>
                  </span>
                  <span className="text-ink-secondary">{formatRupees(o.totalInPaisa)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-2xl border border-hairline bg-surface-2 p-4">
          <h3 className="mb-2 text-sm font-semibold text-ink">Loyalty ledger</h3>
          {ledger.length === 0 ? (
            <p className="text-sm text-ink-faint">No loyalty activity yet.</p>
          ) : (
            <ul className="divide-y divide-hairline/60 text-sm">
              {ledger.map((t) => (
                <li key={t.id} className="flex items-center justify-between py-2">
                  <span>
                    <span className="capitalize">{t.type}</span>
                    {t.note ? <span className="text-ink-faint"> — {t.note}</span> : null}
                  </span>
                  <span className={t.pointsDelta >= 0 ? "text-green-400" : "text-red-400"}>
                    {t.pointsDelta >= 0 ? "+" : ""}
                    {t.pointsDelta}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <CreditTabSection
        slug={slug}
        customerId={customerId}
        outstandingCreditInPaisa={outstandingCreditInPaisa}
        creditLedger={creditLedger}
        canManageAccountBooks={canManageAccountBooks}
        onSettled={load}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Customer Credit / Tab (Commercial Launch Phase B.5)
// ---------------------------------------------------------------------------
// A customer's "tab" is just their own outstanding Account Books ledger
// entries (see getCustomerOutstandingBalance/settleCustomerCredit in
// ledger.ts) — an order completed unpaid/partially paid while linked to
// this customer lands here automatically, with zero extra staff action.
// Settling reuses the exact same due-settlement machinery Account Books'
// own "due tracking" tab already has, just scoped to one customer and
// applied oldest-charge-first for a single lump-sum payment.

function CreditTabSection({
  slug,
  customerId,
  outstandingCreditInPaisa,
  creditLedger,
  canManageAccountBooks,
  onSettled,
}: {
  slug: string;
  customerId: string;
  outstandingCreditInPaisa: number;
  creditLedger: CreditLedgerEntry[];
  canManageAccountBooks: boolean;
  onSettled: () => void;
}) {
  const [showSettle, setShowSettle] = useState(false);
  const dateSystem = useDateSystem();

  if (creditLedger.length === 0) {
    return null; // No credit history at all for this customer — nothing to show.
  }

  return (
    <div className="rounded-2xl border border-hairline bg-surface-2 p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink">Customer tab (credit)</h3>
        {canManageAccountBooks && outstandingCreditInPaisa > 0 && (
          <button onClick={() => setShowSettle((v) => !v)} className="btn-secondary text-xs">
            {showSettle ? "Cancel" : "Record payment"}
          </button>
        )}
      </div>
      <p className="mb-3 text-xs text-ink-muted">
        Orders billed to this customer that finished unpaid or partly paid — settling here reuses
        Account Books&apos; own due-tracking, applied to the oldest charge first.
      </p>

      {showSettle && (
        <SettleCreditForm
          slug={slug}
          customerId={customerId}
          outstandingCreditInPaisa={outstandingCreditInPaisa}
          onSettled={() => {
            setShowSettle(false);
            onSettled();
          }}
        />
      )}

      <ul className="mt-3 divide-y divide-hairline/60 text-sm">
        {creditLedger.map((entry) => (
          <li key={entry.id} className="flex items-center justify-between py-2">
            <span>
              <span className="text-ink-faint">
                {new Date(`${entry.entryDate}T00:00:00Z`).toLocaleDateString(
                  dateSystem === "BS" ? undefined : "en-NP",
                  { day: "numeric", month: "short", timeZone: "UTC" },
                )}
              </span>{" "}
              {entry.description}
              {entry.dueStatus === "outstanding" && (
                <span className="ml-2 rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-medium text-amber-300">
                  Outstanding
                </span>
              )}
              {entry.dueStatus === "settled" && entry.category === "sales" && (
                <span className="ml-2 rounded-full bg-surface-1 px-2 py-0.5 text-[10px] font-medium text-ink-muted">
                  Settled
                </span>
              )}
            </span>
            <span
              className={
                entry.category === "due_settlement"
                  ? "text-green-400"
                  : entry.dueStatus === "outstanding"
                    ? "text-amber-400"
                    : "text-ink-secondary"
              }
            >
              {formatRupees(entry.amountInPaisa)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SettleCreditForm({
  slug,
  customerId,
  outstandingCreditInPaisa,
  onSettled,
}: {
  slug: string;
  customerId: string;
  outstandingCreditInPaisa: number;
  onSettled: () => void;
}) {
  const [amount, setAmount] = useState(String(outstandingCreditInPaisa / 100));
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/customers/${customerId}/credit/settle`, {
        amount: Number(amount),
        note: note || undefined,
      });
      onSettled();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not record this payment.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="mb-3 flex flex-wrap items-end gap-2 rounded-xl border border-hairline bg-surface-1 p-3">
      {error && <p className="w-full text-xs text-red-400">{error}</p>}
      <label className="text-xs">
        <span className="mb-1 block text-ink-secondary">Amount received (Rs)</span>
        <input
          required
          type="number"
          min={0.01}
          step={0.01}
          max={outstandingCreditInPaisa / 100}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="input"
        />
      </label>
      <label className="text-xs">
        <span className="mb-1 block text-ink-secondary">Note (optional)</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} className="input" />
      </label>
      <button disabled={saving} className="btn-primary text-xs disabled:opacity-50">
        {saving ? "Recording…" : "Record payment"}
      </button>
      <span className="text-xs text-ink-faint">Owed: {formatRupees(outstandingCreditInPaisa)}</span>
    </form>
  );
}

/** Small inline editor for the optional credit/tab ceiling — same
 * edit-in-place shape as BirthdayEditor just above. Only rendered for
 * callers with MANAGE_ACCOUNT_BOOKS (see CustomerDetail) — same
 * segregation of duties as the settle action itself: setting how much
 * credit a customer can be extended is a financial-books decision. */
function CreditLimitEditor({
  slug,
  customerId,
  creditLimitInPaisa,
  onSaved,
}: {
  slug: string;
  customerId: string;
  creditLimitInPaisa: number | null;
  onSaved: () => void;
}) {
  const [value, setValue] = useState(creditLimitInPaisa !== null ? String(creditLimitInPaisa / 100) : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setValue(creditLimitInPaisa !== null ? String(creditLimitInPaisa / 100) : "");
  }, [creditLimitInPaisa]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await apiPatch(`${base(slug)}/customers/${customerId}`, {
        creditLimit: value.trim() === "" ? null : Number(value),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the credit limit.");
    } finally {
      setSaving(false);
    }
  }

  const unchanged = value === (creditLimitInPaisa !== null ? String(creditLimitInPaisa / 100) : "");

  return (
    <div className="mt-3 flex flex-wrap items-end gap-2">
      <label className="text-sm">
        <span className="mb-1 block text-ink-secondary">Credit / tab limit (Rs, optional)</span>
        <input
          type="number"
          min={0}
          step={0.01}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="No limit"
          className="input"
        />
      </label>
      <button onClick={save} disabled={saving || unchanged} className="btn-secondary text-xs disabled:opacity-50">
        {saving ? "Saving…" : "Save limit"}
      </button>
      {error && <p className="text-xs text-red-400">{error}</p>}
      <p className="w-full text-xs text-ink-faint">
        Advisory only — shown as a warning on this profile once their tab reaches this amount;
        it never blocks an order. Leave blank for no limit.
      </p>
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
  const dateSystem = useDateSystem();

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
        <span className="mb-1 block text-ink-secondary">Birthday</span>
        <input
          type="date"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="input"
        />
        {dateSystem === "BS" && value && (
          <span className="mt-1 block text-xs text-ink-faint">{formatBsHint(value)}</span>
        )}
      </label>
      <button
        onClick={save}
        disabled={saving || value === (dateOfBirth ?? "")}
        className="btn-secondary text-xs disabled:opacity-50"
      >
        {saving ? "Saving…" : "Save birthday"}
      </button>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {!dateOfBirth && (
        <p className="w-full text-xs text-ink-faint">
          Add their birthday to enable an automatic yearly bonus.
        </p>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "info" | "warning";
}) {
  const valueClass =
    tone === "warning" ? "text-amber-400" : tone === "info" ? "text-orange-400" : "text-ink";
  return (
    <div className={`rounded-xl px-3 py-2 ${tone === "warning" ? "bg-amber-500/15" : "bg-surface-1"}`}>
      <p className="text-xs text-ink-muted">{label}</p>
      <p className={`text-base font-semibold ${valueClass}`}>{value}</p>
    </div>
  );
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <button onClick={onBack} className="text-sm font-medium text-orange-400 hover:underline">
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
    <form onSubmit={submit} className="mt-4 rounded-xl border border-hairline bg-surface-1 p-3">
      {error && <p className="mb-2 rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-400">{error}</p>}
      <p className="mb-2 text-xs text-ink-muted">Current balance: {balance} points</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-sm">
          <span className="mb-1 block text-ink-secondary">Direction</span>
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
          <span className="mb-1 block text-ink-secondary">Points</span>
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
          <span className="mb-1 block text-ink-secondary">Reason</span>
          <input required value={reason} onChange={(e) => setReason(e.target.value)} className="input" />
        </label>
      </div>
      <button disabled={saving} className="btn-primary mt-3">
        {saving ? "Saving…" : "Apply adjustment"}
      </button>
    </form>
  );
}
