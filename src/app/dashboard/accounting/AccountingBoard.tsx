"use client";

import { useEffect, useMemo, useState } from "react";
import { apiGet, apiPost, apiPatch, ApiError } from "@/lib/api-client";
import { formatNPR } from "@/lib/money";
import { useDateSystem } from "@/lib/date-system";
import { formatDate } from "@/lib/nepali-date";
import { useActiveBranch, useBranchSelection } from "@/lib/branch-context";

// ---------------------------------------------------------------------------
// Types — mirror the API shapes in src/lib/accounting/* and the
// accounting/* routes. See ACCOUNTING_MODULE_PLAN.md for the architecture.
// ---------------------------------------------------------------------------

type AccountType = "asset" | "liability" | "equity" | "income" | "expense";
type NormalBalance = "debit" | "credit";

type Account = {
  id: string;
  branchId: string | null;
  code: string;
  name: string;
  type: AccountType;
  normalBalance: NormalBalance;
  parentAccountId: string | null;
  isSystemAccount: boolean;
  isActive: boolean;
  description: string | null;
};

type AccountBalance = {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  normalBalance: NormalBalance;
  isActive: boolean;
  totalDebitInPaisa: number;
  totalCreditInPaisa: number;
  balanceInPaisa: number;
};

type VoucherType =
  | "journal"
  | "sales"
  | "purchase"
  | "payment"
  | "expense"
  | "refund"
  | "contra"
  | "payroll"
  | "opening_balance";

type Voucher = {
  id: string;
  branchId: string;
  voucherType: VoucherType;
  voucherNumber: string;
  voucherDate: string;
  reference: string | null;
  narration: string | null;
  status: "draft" | "approved" | "posted" | "reversed" | "cancelled";
  reversalOfVoucherId: string | null;
  createdAt: string;
};

type VoucherLine = {
  id: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  debitInPaisa: number;
  creditInPaisa: number;
  description: string | null;
};

type Period = {
  id: string;
  branchId: string | null;
  periodStart: string;
  periodEnd: string;
  status: "open" | "closed" | "reopened";
  reopenReason: string | null;
};

type LedgerLine = {
  lineId: string;
  voucherId: string;
  voucherNumber: string;
  voucherType: VoucherType;
  voucherDate: string;
  narration: string | null;
  description: string | null;
  debitInPaisa: number;
  creditInPaisa: number;
  runningBalanceInPaisa: number;
};

const ALL_TABS = [
  "Overview",
  "Chart of Accounts",
  "Journal Vouchers",
  "Day Book",
  "Ledger Accounts",
  "Periods",
] as const;
type Tab = (typeof ALL_TABS)[number];

function base(slug: string) {
  return `/api/restaurants/${slug}`;
}

const VOUCHER_TYPE_LABELS: Record<VoucherType, string> = {
  journal: "Journal",
  sales: "Sales",
  purchase: "Purchase",
  payment: "Payment",
  expense: "Expense",
  refund: "Refund",
  contra: "Contra",
  payroll: "Payroll",
  opening_balance: "Opening Balance",
};

const STATUS_BADGE: Record<Voucher["status"], string> = {
  draft: "bg-neutral-100 text-neutral-600",
  approved: "bg-amber-100 text-amber-800",
  posted: "bg-green-100 text-green-800",
  reversed: "bg-red-100 text-red-800",
  cancelled: "bg-neutral-100 text-neutral-500 line-through",
};

export function AccountingBoard({ slug, canReopenPeriod }: { slug: string; canReopenPeriod: boolean }) {
  const [tab, setTab] = useState<Tab>("Overview");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 border-b border-neutral-200">
        {ALL_TABS.map((t) => (
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

      {tab === "Overview" && <OverviewTab slug={slug} />}
      {tab === "Chart of Accounts" && <ChartOfAccountsTab slug={slug} />}
      {tab === "Journal Vouchers" && <VouchersTab slug={slug} typeFilter="journal" />}
      {tab === "Day Book" && <VouchersTab slug={slug} typeFilter={null} />}
      {tab === "Ledger Accounts" && <LedgerAccountsTab slug={slug} />}
      {tab === "Periods" && <PeriodsTab slug={slug} canReopenPeriod={canReopenPeriod} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

const TYPE_LABELS: Record<AccountType, string> = {
  asset: "Assets",
  liability: "Liabilities",
  equity: "Equity",
  income: "Income",
  expense: "Expenses",
};
const TYPE_ORDER: AccountType[] = ["asset", "liability", "equity", "income", "expense"];

function OverviewTab({ slug }: { slug: string }) {
  const [accounts, setAccounts] = useState<AccountBalance[] | null>(null);
  const [totalsByType, setTotalsByType] = useState<Record<AccountType, number> | null>(null);
  const [openingBalancePosted, setOpeningBalancePosted] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [overview, vouchers] = await Promise.all([
        apiGet<{ accounts: AccountBalance[]; totalsByType: Record<AccountType, number> }>(
          `${base(slug)}/accounting/overview`,
        ),
        apiGet<{ vouchers: Voucher[] }>(`${base(slug)}/accounting/vouchers?type=opening_balance`),
      ]);
      setAccounts(overview.accounts);
      setTotalsByType(overview.totalsByType);
      setOpeningBalancePosted(vouchers.vouchers.length > 0);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load the accounting overview.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  async function setUpChartOfAccounts() {
    setSeeding(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/accounting/seed`, {});
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not set up the chart of accounts.");
    } finally {
      setSeeding(false);
    }
  }

  if (loading) return <p className="text-sm text-neutral-500">Loading…</p>;

  const hasAccounts = (accounts?.length ?? 0) > 0;

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {!hasAccounts && (
        <div className="rounded-2xl border border-orange-200 bg-orange-50 p-4">
          <p className="text-sm font-medium text-orange-900">Accounting isn&apos;t set up yet</p>
          <p className="mt-1 text-sm text-orange-800">
            Create the default chart of accounts to start posting journal vouchers.
          </p>
          <button disabled={seeding} onClick={setUpChartOfAccounts} className="btn-primary mt-3">
            {seeding ? "Setting up…" : "Set up Chart of Accounts"}
          </button>
        </div>
      )}

      {hasAccounts && openingBalancePosted === false && (
        <div className="rounded-2xl border border-neutral-200 bg-neutral-50 p-4 text-sm text-neutral-700">
          No Opening Balance Voucher has been posted yet — post one from the Periods tab when you&apos;re
          ready to record balances as of your cutover date. Until then, every account starts at zero.
        </div>
      )}

      {hasAccounts && (
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {TYPE_ORDER.map((type) => (
            <div key={type} className="rounded-2xl border border-neutral-200 bg-white p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
                {TYPE_LABELS[type]}
              </p>
              <p className="mt-1 text-lg font-semibold text-neutral-900">
                {formatNPR(totalsByType?.[type] ?? 0)}
              </p>
            </div>
          ))}
        </div>
      )}

      <p className="text-xs text-neutral-400">
        These balances only reflect vouchers posted so far — manual journal vouchers and any opening
        balance voucher. Automatic posting from orders, expenses, purchases, and payroll is a later
        phase, so Assets won&apos;t yet equal Liabilities + Equity until that lands.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chart of Accounts
// ---------------------------------------------------------------------------

const ACCOUNT_TYPES: AccountType[] = ["asset", "liability", "equity", "income", "expense"];

function ChartOfAccountsTab({ slug }: { slug: string }) {
  const { branches } = useActiveBranch();
  const [accounts, setAccounts] = useState<AccountBalance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const res = await apiGet<{ accounts: AccountBalance[] }>(`${base(slug)}/accounting/overview`);
      setAccounts(res.accounts);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load the chart of accounts.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  async function toggleActive(account: AccountBalance) {
    try {
      await apiPatch(`${base(slug)}/accounting/chart-of-accounts/${account.accountId}`, {
        isActive: !account.isActive,
      });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update this account.");
    }
  }

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div className="flex justify-end">
        <button onClick={() => setShowAdd((v) => !v)} className="btn-secondary">
          {showAdd ? "Cancel" : "Add account"}
        </button>
      </div>
      {showAdd && (
        <AddAccountForm
          slug={slug}
          branches={branches}
          onAdded={() => {
            setShowAdd(false);
            load();
          }}
        />
      )}

      {loading ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500">
                <th className="px-3 py-2">Code</th>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Normal</th>
                <th className="px-3 py-2 text-right">Balance</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.accountId} className="border-b border-neutral-100 last:border-0">
                  <td className="px-3 py-2 font-mono text-xs text-neutral-500">{a.code}</td>
                  <td className="px-3 py-2 text-neutral-900">{a.name}</td>
                  <td className="px-3 py-2 capitalize text-neutral-600">{a.type}</td>
                  <td className="px-3 py-2 capitalize text-neutral-600">{a.normalBalance}</td>
                  <td className="px-3 py-2 text-right font-medium text-neutral-900">
                    {formatNPR(a.balanceInPaisa)}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        a.isActive ? "bg-green-100 text-green-800" : "bg-neutral-100 text-neutral-500"
                      }`}
                    >
                      {a.isActive ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={() => toggleActive(a)}
                      className="text-xs font-medium text-orange-700 hover:underline"
                    >
                      {a.isActive ? "Deactivate" : "Reactivate"}
                    </button>
                  </td>
                </tr>
              ))}
              {accounts.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-sm text-neutral-400">
                    No accounts yet — set one up from the Overview tab or add one above.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AddAccountForm({
  slug,
  branches,
  onAdded,
}: {
  slug: string;
  branches: Array<{ id: string; name: string }>;
  onAdded: () => void;
}) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState<AccountType>("expense");
  const [normalBalance, setNormalBalance] = useState<NormalBalance>("debit");
  const [branchId, setBranchId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/accounting/chart-of-accounts`, {
        code,
        name,
        type,
        normalBalance,
        branchId: branchId || null,
      });
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add this account.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded-2xl border border-neutral-200 bg-white p-4">
      {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Code</span>
          <input required value={code} onChange={(e) => setCode(e.target.value)} className="input" />
        </label>
        <label className="text-sm sm:col-span-2">
          <span className="mb-1 block text-neutral-600">Name</span>
          <input required value={name} onChange={(e) => setName(e.target.value)} className="input" />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Type</span>
          <select value={type} onChange={(e) => setType(e.target.value as AccountType)} className="input">
            {ACCOUNT_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Normal balance</span>
          <select
            value={normalBalance}
            onChange={(e) => setNormalBalance(e.target.value as NormalBalance)}
            className="input"
          >
            <option value="debit">Debit</option>
            <option value="credit">Credit</option>
          </select>
        </label>
        {branches.length > 1 && (
          <label className="text-sm">
            <span className="mb-1 block text-neutral-600">Branch (optional)</span>
            <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className="input">
              <option value="">Restaurant-wide</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <button disabled={saving} className="btn-primary mt-3">
        {saving ? "Adding…" : "Add account"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Journal Vouchers / Day Book — same component, `typeFilter` narrows which
// voucher types show (Journal Vouchers: only "journal"; Day Book: every
// type, the full chronological record).
// ---------------------------------------------------------------------------

function VouchersTab({ slug, typeFilter }: { slug: string; typeFilter: VoucherType | null }) {
  const dateSystem = useDateSystem();
  const [vouchers, setVouchers] = useState<Voucher[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const qs = typeFilter ? `?type=${typeFilter}` : "";
      const res = await apiGet<{ vouchers: Voucher[] }>(`${base(slug)}/accounting/vouchers${qs}`);
      setVouchers(res.vouchers);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load vouchers.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, typeFilter]);

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {typeFilter === "journal" && (
        <div className="flex justify-end">
          <button onClick={() => setShowAdd((v) => !v)} className="btn-secondary">
            {showAdd ? "Cancel" : "New Journal Voucher"}
          </button>
        </div>
      )}
      {showAdd && (
        <NewJournalVoucherForm
          slug={slug}
          onPosted={() => {
            setShowAdd(false);
            load();
          }}
        />
      )}

      {loading ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500">
                <th className="px-3 py-2">Number</th>
                <th className="px-3 py-2">Date</th>
                {!typeFilter && <th className="px-3 py-2">Type</th>}
                <th className="px-3 py-2">Narration</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {vouchers.map((v) => (
                <VoucherRow
                  key={v.id}
                  slug={slug}
                  voucher={v}
                  showType={!typeFilter}
                  dateSystem={dateSystem}
                  expanded={expanded === v.id}
                  onToggle={() => setExpanded(expanded === v.id ? null : v.id)}
                  onChanged={load}
                />
              ))}
              {vouchers.length === 0 && (
                <tr>
                  <td colSpan={typeFilter ? 5 : 6} className="px-3 py-6 text-center text-sm text-neutral-400">
                    No vouchers yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function VoucherRow({
  slug,
  voucher,
  showType,
  dateSystem,
  expanded,
  onToggle,
  onChanged,
}: {
  slug: string;
  voucher: Voucher;
  showType: boolean;
  dateSystem: ReturnType<typeof useDateSystem>;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const [lines, setLines] = useState<VoucherLine[] | null>(null);
  const [loadingLines, setLoadingLines] = useState(false);
  const [reversing, setReversing] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    onToggle();
    if (!expanded && lines === null) {
      setLoadingLines(true);
      try {
        const res = await apiGet<{ lines: VoucherLine[] }>(
          `${base(slug)}/accounting/vouchers/${voucher.id}`,
        );
        setLines(res.lines);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Could not load this voucher's lines.");
      } finally {
        setLoadingLines(false);
      }
    }
  }

  async function reverse() {
    if (!reason.trim()) {
      setError("A reason is required to reverse a voucher.");
      return;
    }
    setReversing(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/accounting/vouchers/${voucher.id}/reverse`, { reason });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reverse this voucher.");
    } finally {
      setReversing(false);
    }
  }

  return (
    <>
      <tr className="cursor-pointer border-b border-neutral-100 hover:bg-neutral-50" onClick={toggle}>
        <td className="px-3 py-2 font-mono text-xs text-neutral-500">{voucher.voucherNumber}</td>
        <td className="px-3 py-2 text-neutral-600">{formatDate(voucher.voucherDate, dateSystem)}</td>
        {showType && (
          <td className="px-3 py-2 text-neutral-600">{VOUCHER_TYPE_LABELS[voucher.voucherType]}</td>
        )}
        <td className="px-3 py-2 text-neutral-900">{voucher.narration || "—"}</td>
        <td className="px-3 py-2">
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[voucher.status]}`}>
            {voucher.status}
          </span>
        </td>
        <td className="px-3 py-2 text-right text-xs text-neutral-400">{expanded ? "▲" : "▼"}</td>
      </tr>
      {expanded && (
        <tr className="border-b border-neutral-100 bg-neutral-50">
          <td colSpan={showType ? 6 : 5} className="px-3 py-3">
            {error && <p className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
            {loadingLines ? (
              <p className="text-sm text-neutral-500">Loading…</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-neutral-500">
                    <th className="py-1">Account</th>
                    <th className="py-1">Description</th>
                    <th className="py-1 text-right">Debit</th>
                    <th className="py-1 text-right">Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {lines?.map((l) => (
                    <tr key={l.id}>
                      <td className="py-1">
                        {l.accountCode} — {l.accountName}
                      </td>
                      <td className="py-1 text-neutral-500">{l.description || "—"}</td>
                      <td className="py-1 text-right">{l.debitInPaisa > 0 ? formatNPR(l.debitInPaisa) : "—"}</td>
                      <td className="py-1 text-right">
                        {l.creditInPaisa > 0 ? formatNPR(l.creditInPaisa) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {voucher.status === "posted" && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Reason for reversal"
                  className="input max-w-xs"
                  onClick={(e) => e.stopPropagation()}
                />
                <button
                  disabled={reversing}
                  onClick={(e) => {
                    e.stopPropagation();
                    reverse();
                  }}
                  className="btn-secondary"
                >
                  {reversing ? "Reversing…" : "Reverse voucher"}
                </button>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Shared line-editor for the Journal Voucher form (and reused, in spirit,
// by the Opening Balance form in PeriodsTab below).
// ---------------------------------------------------------------------------

type DraftLine = {
  accountId: string;
  side: "debit" | "credit";
  amount: string;
  description: string;
};

function emptyLine(): DraftLine {
  return { accountId: "", side: "debit", amount: "", description: "" };
}

function LineEditor({
  accounts,
  lines,
  setLines,
}: {
  accounts: Account[];
  lines: DraftLine[];
  setLines: (lines: DraftLine[]) => void;
}) {
  function update(i: number, patch: Partial<DraftLine>) {
    setLines(lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }
  function remove(i: number) {
    setLines(lines.filter((_, idx) => idx !== i));
  }

  return (
    <div className="space-y-2">
      {lines.map((line, i) => (
        <div key={i} className="grid grid-cols-12 gap-2">
          <select
            value={line.accountId}
            onChange={(e) => update(i, { accountId: e.target.value })}
            className="input col-span-4"
          >
            <option value="">Select account…</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.name}
              </option>
            ))}
          </select>
          <select
            value={line.side}
            onChange={(e) => update(i, { side: e.target.value as "debit" | "credit" })}
            className="input col-span-2"
          >
            <option value="debit">Debit</option>
            <option value="credit">Credit</option>
          </select>
          <input
            type="number"
            min={0.01}
            step={0.01}
            placeholder="Amount"
            value={line.amount}
            onChange={(e) => update(i, { amount: e.target.value })}
            className="input col-span-2"
          />
          <input
            placeholder="Description (optional)"
            value={line.description}
            onChange={(e) => update(i, { description: e.target.value })}
            className="input col-span-3"
          />
          <button
            type="button"
            onClick={() => remove(i)}
            disabled={lines.length <= 2}
            className="col-span-1 text-xs font-medium text-red-600 hover:underline disabled:opacity-30"
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => setLines([...lines, emptyLine()])}
        className="text-xs font-medium text-orange-700 hover:underline"
      >
        + Add line
      </button>
    </div>
  );
}

function lineTotals(lines: DraftLine[]) {
  let debit = 0;
  let credit = 0;
  for (const l of lines) {
    const amount = Math.round((Number(l.amount) || 0) * 100);
    if (l.side === "debit") debit += amount;
    else credit += amount;
  }
  return { debit, credit };
}

function NewJournalVoucherForm({ slug, onPosted }: { slug: string; onPosted: () => void }) {
  const { branches, branchId, setBranchId } = useBranchSelection();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [voucherDate, setVoucherDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [reference, setReference] = useState("");
  const [narration, setNarration] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([emptyLine(), emptyLine()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<{ accounts: Account[] }>(`${base(slug)}/accounting/chart-of-accounts`)
      .then((res) => setAccounts(res.accounts.filter((a) => a.isActive)))
      .catch(() => {});
  }, [slug]);

  const { debit, credit } = useMemo(() => lineTotals(lines), [lines]);
  const balanced = debit > 0 && debit === credit;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!balanced) {
      setError("Debits and credits must be equal, and greater than zero.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/accounting/vouchers`, {
        branchId,
        voucherDate,
        reference: reference || undefined,
        narration: narration || undefined,
        lines: lines
          .filter((l) => l.accountId && Number(l.amount) > 0)
          .map((l) => ({
            accountId: l.accountId,
            side: l.side,
            amount: Number(l.amount),
            description: l.description || undefined,
          })),
      });
      onPosted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not post this voucher.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-2xl border border-neutral-200 bg-white p-4">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div className="grid gap-3 sm:grid-cols-3">
        {branches.length > 1 && (
          <label className="text-sm">
            <span className="mb-1 block text-neutral-600">Branch</span>
            <select required value={branchId} onChange={(e) => setBranchId(e.target.value)} className="input">
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Date</span>
          <input
            type="date"
            value={voucherDate}
            onChange={(e) => setVoucherDate(e.target.value)}
            className="input"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Reference (optional)</span>
          <input value={reference} onChange={(e) => setReference(e.target.value)} className="input" />
        </label>
        <label className="text-sm sm:col-span-3">
          <span className="mb-1 block text-neutral-600">Narration</span>
          <input
            value={narration}
            onChange={(e) => setNarration(e.target.value)}
            className="input"
            placeholder="What is this entry for?"
          />
        </label>
      </div>

      <LineEditor accounts={accounts} lines={lines} setLines={setLines} />

      <div className="flex items-center justify-between border-t border-neutral-100 pt-3 text-sm">
        <span className={balanced ? "text-green-700" : "text-red-700"}>
          Debit {formatNPR(debit)} · Credit {formatNPR(credit)}
          {!balanced && " — not balanced yet"}
        </span>
        <button disabled={saving || !balanced} className="btn-primary">
          {saving ? "Posting…" : "Post voucher"}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Ledger Accounts
// ---------------------------------------------------------------------------

function LedgerAccountsTab({ slug }: { slug: string }) {
  const dateSystem = useDateSystem();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState("");
  const [account, setAccount] = useState<AccountBalance | null>(null);
  const [lines, setLines] = useState<LedgerLine[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<{ accounts: Account[] }>(`${base(slug)}/accounting/chart-of-accounts`)
      .then((res) => setAccounts(res.accounts))
      .catch(() => {});
  }, [slug]);

  useEffect(() => {
    if (!accountId) {
      setAccount(null);
      setLines([]);
      return;
    }
    setLoading(true);
    apiGet<{ account: AccountBalance; lines: LedgerLine[] }>(
      `${base(slug)}/accounting/chart-of-accounts/${accountId}/ledger`,
    )
      .then((res) => {
        setAccount(res.account);
        setLines(res.lines);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load this ledger."))
      .finally(() => setLoading(false));
  }, [slug, accountId]);

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <label className="block max-w-md text-sm">
        <span className="mb-1 block text-neutral-600">Account</span>
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className="input">
          <option value="">Select an account…</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.code} — {a.name}
            </option>
          ))}
        </select>
      </label>

      {loading && <p className="text-sm text-neutral-500">Loading…</p>}

      {account && !loading && (
        <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white">
          <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-3">
            <div>
              <p className="text-sm font-medium text-neutral-900">
                {account.code} — {account.name}
              </p>
              <p className="text-xs capitalize text-neutral-500">
                {account.type} · {account.normalBalance}-normal
              </p>
            </div>
            <p className="text-lg font-semibold text-neutral-900">{formatNPR(account.balanceInPaisa)}</p>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500">
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Voucher</th>
                <th className="px-3 py-2">Description</th>
                <th className="px-3 py-2 text-right">Debit</th>
                <th className="px-3 py-2 text-right">Credit</th>
                <th className="px-3 py-2 text-right">Balance</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.lineId} className="border-b border-neutral-100 last:border-0">
                  <td className="px-3 py-2 text-neutral-600">{formatDate(l.voucherDate, dateSystem)}</td>
                  <td className="px-3 py-2 font-mono text-xs text-neutral-500">{l.voucherNumber}</td>
                  <td className="px-3 py-2 text-neutral-600">{l.description || l.narration || "—"}</td>
                  <td className="px-3 py-2 text-right">
                    {l.debitInPaisa > 0 ? formatNPR(l.debitInPaisa) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {l.creditInPaisa > 0 ? formatNPR(l.creditInPaisa) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right font-medium text-neutral-900">
                    {formatNPR(l.runningBalanceInPaisa)}
                  </td>
                </tr>
              ))}
              {lines.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-sm text-neutral-400">
                    No activity on this account yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Periods — including the one-time Opening Balance Voucher action.
// ---------------------------------------------------------------------------

function PeriodsTab({ slug, canReopenPeriod }: { slug: string; canReopenPeriod: boolean }) {
  const dateSystem = useDateSystem();
  const [periods, setPeriods] = useState<Period[]>([]);
  const { branches } = useActiveBranch();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [openingBalancePosted, setOpeningBalancePosted] = useState<boolean | null>(null);
  const [showOpeningBalance, setShowOpeningBalance] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [periodsRes, vouchersRes] = await Promise.all([
        apiGet<{ periods: Period[] }>(`${base(slug)}/accounting/periods`),
        apiGet<{ vouchers: Voucher[] }>(`${base(slug)}/accounting/vouchers?type=opening_balance`),
      ]);
      setPeriods(periodsRes.periods);
      setOpeningBalancePosted(vouchersRes.vouchers.length > 0);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load periods.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  function branchName(id: string | null) {
    if (!id) return "All branches";
    return branches.find((b) => b.id === id)?.name ?? "—";
  }

  async function close(period: Period) {
    try {
      await apiPatch(`${base(slug)}/accounting/periods/${period.id}?action=close`, {});
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not close this period.");
    }
  }

  async function reopen(period: Period) {
    const reason = window.prompt("Reason for reopening this period:");
    if (!reason) return;
    try {
      await apiPatch(`${base(slug)}/accounting/periods/${period.id}?action=reopen`, { reason });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reopen this period.");
    }
  }

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="rounded-2xl border border-neutral-200 bg-white p-4">
        <p className="text-sm font-medium text-neutral-900">Opening Balance Voucher</p>
        <p className="mt-1 text-sm text-neutral-500">
          One-time cutover entry — every account&apos;s balance as of the date you start using this
          module. Old Account Books history stays exactly as it is; this doesn&apos;t touch it.
        </p>
        {openingBalancePosted === true && (
          <p className="mt-2 text-sm font-medium text-green-700">Already posted.</p>
        )}
        {openingBalancePosted === false && (
          <>
            <button onClick={() => setShowOpeningBalance((v) => !v)} className="btn-secondary mt-3">
              {showOpeningBalance ? "Cancel" : "Post Opening Balance Voucher"}
            </button>
            {showOpeningBalance && (
              <div className="mt-3">
                <OpeningBalanceForm
                  slug={slug}
                  onPosted={() => {
                    setShowOpeningBalance(false);
                    load();
                  }}
                />
              </div>
            )}
          </>
        )}
      </div>

      <div className="flex justify-end">
        <button onClick={() => setShowAdd((v) => !v)} className="btn-secondary">
          {showAdd ? "Cancel" : "New period"}
        </button>
      </div>
      {showAdd && (
        <NewPeriodForm
          slug={slug}
          branches={branches}
          onAdded={() => {
            setShowAdd(false);
            load();
          }}
        />
      )}

      {loading ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500">
                <th className="px-3 py-2">Range</th>
                <th className="px-3 py-2">Branch</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {periods.map((p) => (
                <tr key={p.id} className="border-b border-neutral-100 last:border-0">
                  <td className="px-3 py-2 text-neutral-900">
                    {formatDate(p.periodStart, dateSystem)} – {formatDate(p.periodEnd, dateSystem)}
                  </td>
                  <td className="px-3 py-2 text-neutral-600">{branchName(p.branchId)}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        p.status === "closed"
                          ? "bg-red-100 text-red-800"
                          : p.status === "reopened"
                            ? "bg-amber-100 text-amber-800"
                            : "bg-green-100 text-green-800"
                      }`}
                    >
                      {p.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    {p.status !== "closed" && (
                      <button onClick={() => close(p)} className="text-xs font-medium text-orange-700 hover:underline">
                        Close
                      </button>
                    )}
                    {p.status === "closed" && canReopenPeriod && (
                      <button onClick={() => reopen(p)} className="text-xs font-medium text-orange-700 hover:underline">
                        Reopen
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {periods.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-6 text-center text-sm text-neutral-400">
                    No periods configured — posting stays open everywhere until you add one.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function NewPeriodForm({
  slug,
  branches,
  onAdded,
}: {
  slug: string;
  branches: Array<{ id: string; name: string }>;
  onAdded: () => void;
}) {
  const [branchId, setBranchId] = useState("");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/accounting/periods`, {
        branchId: branchId || null,
        periodStart,
        periodEnd,
      });
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create this period.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded-2xl border border-neutral-200 bg-white p-4">
      {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Start</span>
          <input
            required
            type="date"
            value={periodStart}
            onChange={(e) => setPeriodStart(e.target.value)}
            className="input"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">End</span>
          <input
            required
            type="date"
            value={periodEnd}
            onChange={(e) => setPeriodEnd(e.target.value)}
            className="input"
          />
        </label>
        {branches.length > 1 && (
          <label className="text-sm">
            <span className="mb-1 block text-neutral-600">Branch (optional)</span>
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
      </div>
      <button disabled={saving} className="btn-primary mt-3">
        {saving ? "Creating…" : "Create period"}
      </button>
    </form>
  );
}

function OpeningBalanceForm({ slug, onPosted }: { slug: string; onPosted: () => void }) {
  const { branches, branchId, setBranchId } = useBranchSelection();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [voucherDate, setVoucherDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<{ accounts: Account[] }>(`${base(slug)}/accounting/chart-of-accounts`)
      .then((res) => setAccounts(res.accounts.filter((a) => a.isActive)))
      .catch(() => {});
  }, [slug]);

  const { debit, credit } = useMemo(() => lineTotals(lines), [lines]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/accounting/opening-balance`, {
        branchId,
        voucherDate,
        lines: lines
          .filter((l) => l.accountId && Number(l.amount) > 0)
          .map((l) => ({
            accountId: l.accountId,
            side: l.side,
            amount: Number(l.amount),
          })),
      });
      onPosted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not post the opening balance voucher.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-2xl border border-neutral-200 bg-neutral-50 p-4">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        {branches.length > 1 && (
          <label className="text-sm">
            <span className="mb-1 block text-neutral-600">Branch</span>
            <select required value={branchId} onChange={(e) => setBranchId(e.target.value)} className="input">
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Cutover date</span>
          <input
            type="date"
            value={voucherDate}
            onChange={(e) => setVoucherDate(e.target.value)}
            className="input"
          />
        </label>
      </div>

      <LineEditor accounts={accounts} lines={lines} setLines={setLines} />

      <p className="text-xs text-neutral-500">
        Enter each account&apos;s known balance as a debit or credit — whatever these don&apos;t already
        net to zero is automatically posted to Opening Balance Equity, so the lines above don&apos;t need
        to balance on their own.
      </p>

      <div className="flex items-center justify-between border-t border-neutral-200 pt-3 text-sm">
        <span className="text-neutral-500">
          Debit {formatNPR(debit)} · Credit {formatNPR(credit)}
        </span>
        <button disabled={saving} className="btn-primary">
          {saving ? "Posting…" : "Post opening balance"}
        </button>
      </div>
    </form>
  );
}
