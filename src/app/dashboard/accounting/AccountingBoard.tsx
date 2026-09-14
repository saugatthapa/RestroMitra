"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { apiGet, apiPost, apiPatch, apiDelete, ApiError } from "@/lib/api-client";
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
  | "opening_balance"
  | "fixed_asset"
  | "depreciation"
  | "loan";

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
  "Bank Accounts",
  "Fixed Assets",
  "Loans",
  "Journal Vouchers",
  "Day Book",
  "Ledger Accounts",
  "Reports",
  "Bank Reconciliation",
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
  fixed_asset: "Fixed Asset",
  depreciation: "Depreciation",
  loan: "Loan",
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
  // Set when a Reports row is clicked ("drill down") so Ledger Accounts opens
  // with that account already selected. Cleared once Ledger Accounts reads
  // it (each tab switch remounts the destination tab, so a plain useState
  // initializer there is enough — see LedgerAccountsTab).
  const [ledgerDrillDownAccountId, setLedgerDrillDownAccountId] = useState<string | null>(null);

  function goToLedger(accountId: string) {
    setLedgerDrillDownAccountId(accountId);
    setTab("Ledger Accounts");
  }

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
      {tab === "Bank Accounts" && <BankAccountsTab slug={slug} />}
      {tab === "Fixed Assets" && <FixedAssetsTab slug={slug} />}
      {tab === "Loans" && <LoansTab slug={slug} />}
      {tab === "Journal Vouchers" && <VouchersTab slug={slug} typeFilter="journal" />}
      {tab === "Day Book" && <VouchersTab slug={slug} typeFilter={null} />}
      {tab === "Ledger Accounts" && (
        <LedgerAccountsTab slug={slug} initialAccountId={ledgerDrillDownAccountId} />
      )}
      {tab === "Reports" && <ReportsTab slug={slug} onDrillDown={goToLedger} />}
      {tab === "Bank Reconciliation" && <BankReconciliationTab slug={slug} />}
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
  const [automaticPostingEnabledAt, setAutomaticPostingEnabledAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);
  const [enabling, setEnabling] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [overview, vouchers] = await Promise.all([
        apiGet<{
          accounts: AccountBalance[];
          totalsByType: Record<AccountType, number>;
          automaticPostingEnabledAt: string | null;
        }>(`${base(slug)}/accounting/overview`),
        apiGet<{ vouchers: Voucher[] }>(`${base(slug)}/accounting/vouchers?type=opening_balance`),
      ]);
      setAccounts(overview.accounts);
      setTotalsByType(overview.totalsByType);
      setAutomaticPostingEnabledAt(overview.automaticPostingEnabledAt);
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

  async function enableAutomaticPosting() {
    setEnabling(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/accounting/enable-automatic-posting`, {});
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not enable automatic posting.");
    } finally {
      setEnabling(false);
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

      {hasAccounts && !automaticPostingEnabledAt && (
        <div className="rounded-2xl border border-neutral-200 bg-white p-4">
          <p className="text-sm font-medium text-neutral-900">Automatic posting is off</p>
          <p className="mt-1 text-sm text-neutral-600">
            Right now, only manual journal vouchers and the opening balance land in these books.
            Enabling automatic posting starts booking a Sales Voucher (and its matching cost-of-goods
            entry) every time an order completes — a real, permanent change to what gets posted from
            that point forward. There&apos;s no way to turn it back off once enabled.
          </p>
          <button disabled={enabling} onClick={enableAutomaticPosting} className="btn-primary mt-3">
            {enabling ? "Enabling…" : "Enable automatic posting"}
          </button>
        </div>
      )}

      {hasAccounts && automaticPostingEnabledAt && (
        <div className="rounded-2xl border border-green-200 bg-green-50 p-4 text-sm text-green-800">
          Automatic posting has been on since{" "}
          {new Date(automaticPostingEnabledAt).toLocaleString()}. Completed orders post a Sales
          Voucher automatically; other flows (expenses, purchases, payroll) are still manual-only
          until their own integrations land.
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
        {automaticPostingEnabledAt
          ? "These balances include automatic Sales Vouchers from completed orders. Expenses, purchases, and payroll still only post when entered manually, so Assets won't fully equal Liabilities + Equity until those integrations land too."
          : "These balances only reflect vouchers posted so far — manual journal vouchers and any opening balance voucher. Automatic posting from orders, expenses, purchases, and payroll is a later phase, so Assets won't yet equal Liabilities + Equity until that lands."}
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

function LedgerAccountsTab({
  slug,
  initialAccountId,
}: {
  slug: string;
  // Set by a Reports-tab drill-down click (see AccountingBoard.goToLedger).
  // A plain useState initializer is enough because switching to this tab
  // always remounts it fresh — there's no stale-prop case to guard against.
  initialAccountId?: string | null;
}) {
  const dateSystem = useDateSystem();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState(initialAccountId ?? "");
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
// Reports — Trial Balance, Profit & Loss, Balance Sheet (Phase 3). Cash Flow
// is deliberately not here — see ACCOUNTING_MODULE_PLAN.md's review
// correction #5 (relocated to Phase 5, once Phase 4's automatic postings
// give it real operating/investing/financing activity to reconcile
// against). Clicking any account name drills into Ledger Accounts.
// ---------------------------------------------------------------------------

type TrialBalanceRow = {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  debitInPaisa: number;
  creditInPaisa: number;
};
type TrialBalanceData = {
  asOfDate: string | null;
  rows: TrialBalanceRow[];
  totalDebitInPaisa: number;
  totalCreditInPaisa: number;
  isBalanced: boolean;
};

type StatementLine = { accountId: string; code: string; name: string; amountInPaisa: number };
type ProfitAndLossData = {
  fromDate: string | null;
  toDate: string | null;
  income: StatementLine[];
  expenses: StatementLine[];
  totalIncomeInPaisa: number;
  totalExpenseInPaisa: number;
  netIncomeInPaisa: number;
};
type BalanceSheetData = {
  asOfDate: string | null;
  assets: StatementLine[];
  liabilities: StatementLine[];
  equity: StatementLine[];
  currentPeriodEarningsInPaisa: number;
  totalAssetsInPaisa: number;
  totalLiabilitiesInPaisa: number;
  totalEquityInPaisa: number;
  isBalanced: boolean;
};

// Phase 5, Slice 5a — AR/AP aging. Mirrors src/lib/accounting/aging.ts's
// own AgingReport/AgingRow/AgingBucketKey types.
type AgingBucketKey = "current" | "days1to30" | "days31to60" | "days61to90" | "over90";
const AGING_BUCKETS: { key: AgingBucketKey; label: string }[] = [
  { key: "current", label: "Current" },
  { key: "days1to30", label: "1–30 days" },
  { key: "days31to60", label: "31–60 days" },
  { key: "days61to90", label: "61–90 days" },
  { key: "over90", label: "90+ days" },
];
type AgingRow = {
  partyId: string;
  partyName: string;
  outstandingInPaisa: number;
  buckets: Record<AgingBucketKey, number>;
  oldestChargeDate: string | null;
};
type AgingReportData = {
  asOfDate: string;
  controlAccountId: string;
  rows: AgingRow[];
  totalOutstandingInPaisa: number;
};

const REPORT_TABS = [
  "Trial Balance",
  "Profit & Loss",
  "Balance Sheet",
  "Cash Flow",
  "AR/AP Aging",
  "VAT Return",
  "Tax Depreciation",
] as const;
type ReportTab = (typeof REPORT_TABS)[number];

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
function firstOfMonthIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function ReportsTab({ slug, onDrillDown }: { slug: string; onDrillDown: (accountId: string) => void }) {
  const [reportTab, setReportTab] = useState<ReportTab>("Trial Balance");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {REPORT_TABS.map((t) => (
          <button
            key={t}
            onClick={() => setReportTab(t)}
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              reportTab === t
                ? "bg-orange-100 text-orange-800"
                : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {reportTab === "Trial Balance" && <TrialBalanceReport slug={slug} onDrillDown={onDrillDown} />}
      {reportTab === "Profit & Loss" && <ProfitAndLossReport slug={slug} onDrillDown={onDrillDown} />}
      {reportTab === "Balance Sheet" && <BalanceSheetReport slug={slug} onDrillDown={onDrillDown} />}
      {reportTab === "Cash Flow" && <CashFlowReport slug={slug} />}
      {reportTab === "AR/AP Aging" && <AgingReportTab slug={slug} />}
      {reportTab === "VAT Return" && <VatReturnReport slug={slug} />}
      {reportTab === "Tax Depreciation" && <TaxDepreciationReportTab slug={slug} />}
    </div>
  );
}

function AccountLink({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="text-left text-neutral-900 hover:text-orange-700 hover:underline">
      {name}
    </button>
  );
}

function TrialBalanceReport({ slug, onDrillDown }: { slug: string; onDrillDown: (accountId: string) => void }) {
  const [asOfDate, setAsOfDate] = useState(todayIso());
  const [data, setData] = useState<TrialBalanceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    apiGet<TrialBalanceData>(`${base(slug)}/accounting/reports/trial-balance?asOfDate=${asOfDate}`)
      .then((res) => {
        setData(res);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load the Trial Balance."))
      .finally(() => setLoading(false));
  }, [slug, asOfDate]);

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <label className="block max-w-xs text-sm">
        <span className="mb-1 block text-neutral-600">As of</span>
        <input type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} className="input" />
      </label>

      {loading ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : (
        data && (
          <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500">
                  <th className="px-3 py-2">Code</th>
                  <th className="px-3 py-2">Account</th>
                  <th className="px-3 py-2 text-right">Debit</th>
                  <th className="px-3 py-2 text-right">Credit</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.accountId} className="border-b border-neutral-100 last:border-0">
                    <td className="px-3 py-2 font-mono text-xs text-neutral-500">{r.code}</td>
                    <td className="px-3 py-2">
                      <AccountLink name={r.name} onClick={() => onDrillDown(r.accountId)} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      {r.debitInPaisa > 0 ? formatNPR(r.debitInPaisa) : "—"}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {r.creditInPaisa > 0 ? formatNPR(r.creditInPaisa) : "—"}
                    </td>
                  </tr>
                ))}
                {data.rows.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-6 text-center text-sm text-neutral-400">
                      No activity as of this date.
                    </td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-neutral-300 font-semibold text-neutral-900">
                  <td className="px-3 py-2" colSpan={2}>
                    Total
                  </td>
                  <td className="px-3 py-2 text-right">{formatNPR(data.totalDebitInPaisa)}</td>
                  <td className="px-3 py-2 text-right">{formatNPR(data.totalCreditInPaisa)}</td>
                </tr>
              </tfoot>
            </table>
            <div
              className={`border-t border-neutral-200 px-4 py-2 text-xs ${
                data.isBalanced ? "text-green-700" : "text-red-700"
              }`}
            >
              {data.isBalanced
                ? "Debit and credit totals match."
                : "Debit and credit totals do NOT match — that points to a data problem, since postVoucher() never allows an unbalanced posting."}
            </div>
          </div>
        )
      )}
    </div>
  );
}

function ProfitAndLossReport({ slug, onDrillDown }: { slug: string; onDrillDown: (accountId: string) => void }) {
  const [fromDate, setFromDate] = useState(firstOfMonthIso());
  const [toDate, setToDate] = useState(todayIso());
  const [data, setData] = useState<ProfitAndLossData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    apiGet<ProfitAndLossData>(
      `${base(slug)}/accounting/reports/profit-and-loss?fromDate=${fromDate}&toDate=${toDate}`,
    )
      .then((res) => {
        setData(res);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load Profit & Loss."))
      .finally(() => setLoading(false));
  }, [slug, fromDate, toDate]);

  function Section({ title, lines, total }: { title: string; lines: StatementLine[]; total: number }) {
    return (
      <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white">
        <div className="border-b border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-900">{title}</div>
        <table className="w-full text-sm">
          <tbody>
            {lines.map((l) => (
              <tr key={l.accountId} className="border-b border-neutral-100 last:border-0">
                <td className="px-4 py-2 font-mono text-xs text-neutral-500">{l.code}</td>
                <td className="px-3 py-2">
                  <AccountLink name={l.name} onClick={() => onDrillDown(l.accountId)} />
                </td>
                <td className="px-3 py-2 text-right">{formatNPR(l.amountInPaisa)}</td>
              </tr>
            ))}
            {lines.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-4 text-center text-sm text-neutral-400">
                  No activity in this period.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-neutral-300 font-semibold text-neutral-900">
              <td className="px-4 py-2" colSpan={2}>
                Total {title}
              </td>
              <td className="px-3 py-2 text-right">{formatNPR(total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div className="grid max-w-md gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">From</span>
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="input" />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">To</span>
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="input" />
        </label>
      </div>

      {loading ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : (
        data && (
          <div className="space-y-4">
            <Section title="Income" lines={data.income} total={data.totalIncomeInPaisa} />
            <Section title="Expenses" lines={data.expenses} total={data.totalExpenseInPaisa} />
            <div className="flex items-center justify-between rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-3">
              <span className="text-sm font-medium text-neutral-900">Net Income</span>
              <span
                className={`text-sm font-semibold ${
                  data.netIncomeInPaisa >= 0 ? "text-green-700" : "text-red-700"
                }`}
              >
                {formatNPR(data.netIncomeInPaisa)}
              </span>
            </div>
          </div>
        )
      )}
    </div>
  );
}

function BalanceSheetReport({ slug, onDrillDown }: { slug: string; onDrillDown: (accountId: string) => void }) {
  const [asOfDate, setAsOfDate] = useState(todayIso());
  const [data, setData] = useState<BalanceSheetData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    apiGet<BalanceSheetData>(`${base(slug)}/accounting/reports/balance-sheet?asOfDate=${asOfDate}`)
      .then((res) => {
        setData(res);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load the Balance Sheet."))
      .finally(() => setLoading(false));
  }, [slug, asOfDate]);

  function Section({ title, lines, total }: { title: string; lines: StatementLine[]; total: number }) {
    return (
      <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white">
        <div className="border-b border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-900">{title}</div>
        <table className="w-full text-sm">
          <tbody>
            {lines.map((l) => (
              <tr key={l.accountId} className="border-b border-neutral-100 last:border-0">
                <td className="px-4 py-2 font-mono text-xs text-neutral-500">{l.code}</td>
                <td className="px-3 py-2">
                  <AccountLink name={l.name} onClick={() => onDrillDown(l.accountId)} />
                </td>
                <td className="px-3 py-2 text-right">{formatNPR(l.amountInPaisa)}</td>
              </tr>
            ))}
            {lines.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-4 text-center text-sm text-neutral-400">
                  No balance in this section.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-neutral-300 font-semibold text-neutral-900">
              <td className="px-4 py-2" colSpan={2}>
                Total {title}
              </td>
              <td className="px-3 py-2 text-right">{formatNPR(total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <label className="block max-w-xs text-sm">
        <span className="mb-1 block text-neutral-600">As of</span>
        <input type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} className="input" />
      </label>

      {loading ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : (
        data && (
          <div className="space-y-4">
            <Section title="Assets" lines={data.assets} total={data.totalAssetsInPaisa} />
            <Section title="Liabilities" lines={data.liabilities} total={data.totalLiabilitiesInPaisa} />
            <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white">
              <div className="border-b border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-900">
                Equity
              </div>
              <table className="w-full text-sm">
                <tbody>
                  {data.equity.map((l) => (
                    <tr key={l.accountId} className="border-b border-neutral-100 last:border-0">
                      <td className="px-4 py-2 font-mono text-xs text-neutral-500">{l.code}</td>
                      <td className="px-3 py-2">
                        <AccountLink name={l.name} onClick={() => onDrillDown(l.accountId)} />
                      </td>
                      <td className="px-3 py-2 text-right">{formatNPR(l.amountInPaisa)}</td>
                    </tr>
                  ))}
                  <tr className="border-b border-neutral-100 last:border-0">
                    <td className="px-4 py-2" />
                    <td className="px-3 py-2 text-neutral-600">
                      Current Period Earnings
                      <span className="ml-1 text-xs text-neutral-400">(net income to date)</span>
                    </td>
                    <td className="px-3 py-2 text-right">{formatNPR(data.currentPeriodEarningsInPaisa)}</td>
                  </tr>
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-neutral-300 font-semibold text-neutral-900">
                    <td className="px-4 py-2" colSpan={2}>
                      Total Equity
                    </td>
                    <td className="px-3 py-2 text-right">{formatNPR(data.totalEquityInPaisa)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <div
              className={`rounded-2xl border px-4 py-2 text-xs ${
                data.isBalanced
                  ? "border-green-200 bg-green-50 text-green-700"
                  : "border-red-200 bg-red-50 text-red-700"
              }`}
            >
              {data.isBalanced
                ? "Assets = Liabilities + Equity (including Current Period Earnings)."
                : "Assets do NOT equal Liabilities + Equity — that points to a data problem."}
            </div>
            <p className="text-xs text-neutral-400">
              Current Period Earnings folds in net income since inception because there are no
              period-closing entries yet. This keeps the sheet balanced arithmetically, but it won&apos;t
              reflect every real-world balance (inventory, accrued liabilities, etc.) until Phase 4/5&apos;s
              automatic postings land.
            </p>
          </div>
        )
      )}
    </div>
  );
}

type CashFlowLine = { label: string; amountInPaisa: number };
type CashFlowSection = { lines: CashFlowLine[]; totalInPaisa: number };
type CashFlowData = {
  fromDate: string;
  toDate: string;
  beginningCashInPaisa: number;
  endingCashInPaisa: number;
  operating: CashFlowSection;
  investing: CashFlowSection;
  financing: CashFlowSection;
  netChangeInCashInPaisa: number;
  isReconciled: boolean;
};

/**
 * Phase 5, Slice 5c — Cash Flow Statement, indirect method. See
 * cash-flow.ts's own top-of-file comment for the full classification
 * rules; `isReconciled` here is a genuine correctness check (it can only
 * be true if the classification below is complete), not a tautology.
 */
function CashFlowReport({ slug }: { slug: string }) {
  const [fromDate, setFromDate] = useState(firstOfMonthIso());
  const [toDate, setToDate] = useState(todayIso());
  const [data, setData] = useState<CashFlowData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    apiGet<CashFlowData>(`${base(slug)}/accounting/reports/cash-flow?fromDate=${fromDate}&toDate=${toDate}`)
      .then((res) => {
        setData(res);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load the Cash Flow Statement."))
      .finally(() => setLoading(false));
  }, [slug, fromDate, toDate]);

  function Section({ title, section }: { title: string; section: CashFlowSection }) {
    return (
      <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white">
        <div className="border-b border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-900">{title}</div>
        <table className="w-full text-sm">
          <tbody>
            {section.lines.map((l, i) => (
              <tr key={i} className="border-b border-neutral-100 last:border-0">
                <td className="px-4 py-2 text-neutral-600">{l.label}</td>
                <td className="px-3 py-2 text-right">{formatNPR(l.amountInPaisa)}</td>
              </tr>
            ))}
            {section.lines.length === 0 && (
              <tr>
                <td colSpan={2} className="px-4 py-4 text-center text-sm text-neutral-400">
                  No activity in this period.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-neutral-300 font-semibold text-neutral-900">
              <td className="px-4 py-2">Net cash from {title.toLowerCase()}</td>
              <td className="px-3 py-2 text-right">{formatNPR(section.totalInPaisa)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div className="grid max-w-md gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">From</span>
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="input" />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">To</span>
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="input" />
        </label>
      </div>

      {loading ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : (
        data && (
          <div className="space-y-4">
            <div className="flex items-center justify-between rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm">
              <span className="text-neutral-600">Beginning cash</span>
              <span className="font-medium text-neutral-900">{formatNPR(data.beginningCashInPaisa)}</span>
            </div>
            <Section title="Operating Activities" section={data.operating} />
            <Section title="Investing Activities" section={data.investing} />
            <Section title="Financing Activities" section={data.financing} />
            <div className="flex items-center justify-between rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm">
              <span className="text-neutral-600">Net change in cash</span>
              <span className="font-medium text-neutral-900">{formatNPR(data.netChangeInCashInPaisa)}</span>
            </div>
            <div className="flex items-center justify-between rounded-2xl border border-neutral-200 bg-white px-4 py-3 text-sm">
              <span className="font-medium text-neutral-900">Ending cash</span>
              <span className="font-semibold text-neutral-900">{formatNPR(data.endingCashInPaisa)}</span>
            </div>
            <div
              className={`rounded-2xl border px-4 py-2 text-xs ${
                data.isReconciled
                  ? "border-green-200 bg-green-50 text-green-700"
                  : "border-red-200 bg-red-50 text-red-700"
              }`}
            >
              {data.isReconciled
                ? "Reconciled — the net change in cash above matches the actual change in cash and bank account balances exactly."
                : "Not reconciled — the classified activity above does not match the actual change in cash and bank account balances. This can happen if an opening-balance voucher touching cash falls inside the chosen period."}
            </div>
            <p className="text-xs text-neutral-400">
              Indirect method — the Operating section starts from Net Income and adjusts for
              non-cash depreciation and loan interest paid; a &quot;changes in working capital and
              other operating activity&quot; line absorbs everything else so the section&apos;s total
              always matches actual operating cash movement.
            </p>
          </div>
        )
      )}
    </div>
  );
}

type VatReturnData = {
  fromDate: string;
  toDate: string;
  outputVatInPaisa: number;
  inputVatInPaisa: number;
  netPayableInPaisa: number;
};

/**
 * Phase 6, Slice 6c — VAT return / tax summary for a period. See
 * vat-return.ts's own top-of-file comment for exactly what "Output VAT"
 * and "Input VAT" mean here (net period movement, not a running balance)
 * and its documented limitation (a sales refund doesn't reduce Output VAT
 * in this version). Explicitly a reference summary, never a claim of being
 * a filable IRD form — the note below says so plainly.
 */
function VatReturnReport({ slug }: { slug: string }) {
  const [fromDate, setFromDate] = useState(firstOfMonthIso());
  const [toDate, setToDate] = useState(todayIso());
  const [data, setData] = useState<VatReturnData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    apiGet<VatReturnData>(`${base(slug)}/accounting/reports/vat-return?fromDate=${fromDate}&toDate=${toDate}`)
      .then((res) => {
        setData(res);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load the VAT return summary."))
      .finally(() => setLoading(false));
  }, [slug, fromDate, toDate]);

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div className="grid max-w-md gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">From</span>
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="input" />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">To</span>
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="input" />
        </label>
      </div>

      {loading ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : (
        data && (
          <div className="space-y-4">
            <div className="flex items-center justify-between rounded-2xl border border-neutral-200 bg-white px-4 py-3 text-sm">
              <span className="text-neutral-600">Output VAT (collected on sales)</span>
              <span className="font-medium text-neutral-900">{formatNPR(data.outputVatInPaisa)}</span>
            </div>
            <div className="flex items-center justify-between rounded-2xl border border-neutral-200 bg-white px-4 py-3 text-sm">
              <span className="text-neutral-600">Input VAT (paid on purchases)</span>
              <span className="font-medium text-neutral-900">{formatNPR(data.inputVatInPaisa)}</span>
            </div>
            <div className="flex items-center justify-between rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm">
              <span className="font-medium text-neutral-900">
                {data.netPayableInPaisa >= 0 ? "Net VAT payable" : "Net VAT refundable/creditable"}
              </span>
              <span className="font-semibold text-neutral-900">{formatNPR(Math.abs(data.netPayableInPaisa))}</span>
            </div>
            <p className="text-xs text-neutral-400">
              A reference summary for your own records or your accountant — not a filable IRD
              return. Output VAT already subtracts tax on refunded sales, prorated by each
              order&apos;s own overall tax rate — exact for a full refund or a single flat tax
              rate, an estimate for a partial refund of an order that genuinely mixes tax rates.
              Input VAT only reflects purchases where a VAT amount was actually entered. Verify
              every figure before filing.
            </p>
          </div>
        )
      )}
    </div>
  );
}

type TaxDepreciationPoolYearRow = {
  incomeYear: number;
  incomeYearLabel: string;
  openingBalanceInPaisa: number;
  additionsInPaisa: number;
  disposalProceedsInPaisa: number;
  poolValueBeforeDepreciationInPaisa: number;
  balancingChargeInPaisa: number;
  isDeMinimisWriteOff: boolean;
  depreciationChargeInPaisa: number;
  closingBalanceInPaisa: number;
};

type TaxDepreciationIntangibleYearRow = {
  incomeYear: number;
  incomeYearLabel: string;
  openingBalanceInPaisa: number;
  depreciationChargeInPaisa: number;
  closingBalanceInPaisa: number;
};

type TaxDepreciationIntangible = {
  fixedAssetId: string;
  name: string;
  costInPaisa: number;
  usefulLifeYears: number;
  years: TaxDepreciationIntangibleYearRow[];
};

type TaxDepreciationData = {
  throughIncomeYear: number;
  throughIncomeYearLabel: string;
  pools: Array<{
    pool: "A" | "B" | "C" | "D";
    ratePercent: number;
    assetCount: number;
    years: TaxDepreciationPoolYearRow[];
  }>;
  intangibles: TaxDepreciationIntangible[];
  unclassifiedAssetCount: number;
};

const TAX_DEPRECIATION_POOL_NAMES: Record<"A" | "B" | "C" | "D", string> = {
  A: "Pool A — Buildings",
  B: "Pool B — Computers/furniture/office equipment",
  C: "Pool C — Vehicles",
  D: "Pool D — Construction equipment/other",
};

/**
 * Phase 6, Slice 6e — Nepal tax depreciation (pooled declining-balance), a
 * SECOND, INDEPENDENT report alongside the Fixed Assets tab's own
 * straight-line book depreciation — it never affects those figures. See
 * tax-depreciation.ts's own top-of-file comment for the full mechanics and
 * this report's verification status; the caveat below says the same thing
 * in plain language for whoever's reading the report itself.
 */
function TaxDepreciationReportTab({ slug }: { slug: string }) {
  const [incomeYear, setIncomeYear] = useState<number | null>(null);
  const [data, setData] = useState<TaxDepreciationData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    const qs = incomeYear != null ? `?incomeYear=${incomeYear}` : "";
    apiGet<TaxDepreciationData>(`${base(slug)}/accounting/reports/tax-depreciation${qs}`)
      .then((res) => {
        setData(res);
        setError(null);
        setIncomeYear((prev) => prev ?? res.throughIncomeYear);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load the tax depreciation report."))
      .finally(() => setLoading(false));
  }, [slug, incomeYear]);

  function PoolTable({ pool }: { pool: TaxDepreciationData["pools"][number] }) {
    if (pool.assetCount === 0) return null;
    return (
      <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white">
        <div className="border-b border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-900">
          {TAX_DEPRECIATION_POOL_NAMES[pool.pool]} · {pool.ratePercent}% · {pool.assetCount} asset
          {pool.assetCount === 1 ? "" : "s"}
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500">
              <th className="px-3 py-2">Income year</th>
              <th className="px-3 py-2 text-right">Opening</th>
              <th className="px-3 py-2 text-right">Additions</th>
              <th className="px-3 py-2 text-right">Disposals</th>
              <th className="px-3 py-2 text-right">Depreciation</th>
              <th className="px-3 py-2 text-right">Closing</th>
            </tr>
          </thead>
          <tbody>
            {pool.years.map((y) => (
              <tr key={y.incomeYear} className="border-b border-neutral-100 last:border-0">
                <td className="px-3 py-2 text-neutral-600">{y.incomeYearLabel}</td>
                <td className="px-3 py-2 text-right">{formatNPR(y.openingBalanceInPaisa)}</td>
                <td className="px-3 py-2 text-right">{formatNPR(y.additionsInPaisa)}</td>
                <td className="px-3 py-2 text-right">{formatNPR(y.disposalProceedsInPaisa)}</td>
                <td className="px-3 py-2 text-right">
                  {formatNPR(y.depreciationChargeInPaisa)}
                  {y.isDeMinimisWriteOff && (
                    <span className="ml-1 rounded-full bg-orange-100 px-1.5 py-0.5 text-[10px] font-medium text-orange-800">
                      de minimis
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-right font-medium">{formatNPR(y.closingBalanceInPaisa)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {pool.years.some((y) => y.balancingChargeInPaisa > 0) && (
          <div className="border-t border-orange-200 bg-orange-50 px-4 py-2 text-xs text-orange-800">
            {pool.years
              .filter((y) => y.balancingChargeInPaisa > 0)
              .map((y) => (
                <div key={y.incomeYear}>
                  {y.incomeYearLabel}: disposal proceeds exceeded this pool&apos;s value by{" "}
                  {formatNPR(y.balancingChargeInPaisa)} — a balancing charge (taxable income for that
                  year, not a depreciation figure). Not posted to your ledger by this report.
                </div>
              ))}
          </div>
        )}
      </div>
    );
  }

  function IntangibleTable({ asset }: { asset: TaxDepreciationIntangible }) {
    return (
      <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white">
        <div className="border-b border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-900">
          {asset.name} · {formatNPR(asset.costInPaisa)} · {asset.usefulLifeYears}-year life
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500">
              <th className="px-3 py-2">Income year</th>
              <th className="px-3 py-2 text-right">Opening</th>
              <th className="px-3 py-2 text-right">Depreciation</th>
              <th className="px-3 py-2 text-right">Closing</th>
            </tr>
          </thead>
          <tbody>
            {asset.years.map((y) => (
              <tr key={y.incomeYear} className="border-b border-neutral-100 last:border-0">
                <td className="px-3 py-2 text-neutral-600">{y.incomeYearLabel}</td>
                <td className="px-3 py-2 text-right">{formatNPR(y.openingBalanceInPaisa)}</td>
                <td className="px-3 py-2 text-right">{formatNPR(y.depreciationChargeInPaisa)}</td>
                <td className="px-3 py-2 text-right font-medium">{formatNPR(y.closingBalanceInPaisa)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="rounded-2xl border border-orange-200 bg-orange-50 px-4 py-3 text-xs text-orange-800">
        A reference computation for your own records or your accountant — never a filable IRD
        schedule. The pool rates and the mid-year &quot;thirds&quot; first-year rule are
        corroborated across several sources; the disposal balancing-charge mechanic and the
        Rs. 2,000 write-off rule are less certain. Verify every figure against the IRD or a
        licensed Nepali chartered accountant before relying on it for an actual filing.
      </div>

      <label className="block max-w-xs text-sm">
        <span className="mb-1 block text-neutral-600">Nepali income year (B.S.)</span>
        <input
          type="number"
          className="input"
          value={incomeYear ?? ""}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isInteger(v)) setIncomeYear(v);
          }}
        />
        {data && <span className="mt-1 block text-xs text-neutral-400">{data.throughIncomeYearLabel}</span>}
      </label>

      {loading ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : (
        data && (
          <div className="space-y-4">
            {data.unclassifiedAssetCount > 0 && (
              <p className="rounded-lg bg-neutral-50 px-3 py-2 text-xs text-neutral-500">
                {data.unclassifiedAssetCount} active fixed asset{data.unclassifiedAssetCount === 1 ? "" : "s"} not
                yet classified into a tax pool — set each one&apos;s &quot;Tax pool&quot; on the Fixed Assets
                tab to include it here.
              </p>
            )}

            {data.pools.map((p) => (
              <PoolTable key={p.pool} pool={p} />
            ))}
            {data.intangibles.map((a) => (
              <IntangibleTable key={a.fixedAssetId} asset={a} />
            ))}

            {data.pools.every((p) => p.assetCount === 0) && data.intangibles.length === 0 && (
              <p className="text-sm text-neutral-400">
                No fixed assets classified into a tax pool yet.
              </p>
            )}
          </div>
        )
      )}
    </div>
  );
}

const AGING_SIDES = ["Payable", "Receivable"] as const;
type AgingSide = (typeof AGING_SIDES)[number];

/**
 * Phase 5, Slice 5a — AR/AP aging. A restaurant can view this before ever
 * enabling automatic posting; the API returns `{ report: null }` (not an
 * error) when the relevant control account (Accounts Payable/Receivable)
 * isn't mapped yet, which we render as a plain explanatory note rather than
 * an error banner. No drill-down here — unlike the other reports, these
 * rows are suppliers/customers, not chart-of-accounts entries.
 */
function AgingReportTab({ slug }: { slug: string }) {
  const [side, setSide] = useState<AgingSide>("Payable");
  const [asOfDate, setAsOfDate] = useState(todayIso());
  const [data, setData] = useState<AgingReportData | null>(null);
  const [notSetUp, setNotSetUp] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    const endpoint = side === "Payable" ? "ap-aging" : "ar-aging";
    apiGet<{ report: AgingReportData | null }>(`${base(slug)}/accounting/reports/${endpoint}?asOfDate=${asOfDate}`)
      .then((res) => {
        setData(res.report);
        setNotSetUp(res.report === null);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load the aging report."))
      .finally(() => setLoading(false));
  }, [slug, side, asOfDate]);

  const partyLabel = side === "Payable" ? "Supplier" : "Customer";

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex gap-2">
          {AGING_SIDES.map((s) => (
            <button
              key={s}
              onClick={() => setSide(s)}
              className={`rounded-full px-3 py-1 text-xs font-medium ${
                side === s
                  ? "bg-orange-100 text-orange-800"
                  : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
              }`}
            >
              Accounts {s}
            </button>
          ))}
        </div>
        <label className="block max-w-xs text-sm">
          <span className="mb-1 block text-neutral-600">As of</span>
          <input type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} className="input" />
        </label>
      </div>

      {loading ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : notSetUp ? (
        <p className="rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-6 text-center text-sm text-neutral-500">
          Accounts {side} isn&apos;t set up for this restaurant yet — this report will populate once automatic
          posting is enabled and at least one {partyLabel.toLowerCase()} transaction has been posted through it.
        </p>
      ) : (
        data && (
          <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500">
                  <th className="px-3 py-2">{partyLabel}</th>
                  {AGING_BUCKETS.map((b) => (
                    <th key={b.key} className="px-3 py-2 text-right">
                      {b.label}
                    </th>
                  ))}
                  <th className="px-3 py-2 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.partyId} className="border-b border-neutral-100 last:border-0">
                    <td className="px-3 py-2">{r.partyName}</td>
                    {AGING_BUCKETS.map((b) => (
                      <td key={b.key} className="px-3 py-2 text-right">
                        {r.buckets[b.key] !== 0 ? formatNPR(r.buckets[b.key]) : "—"}
                      </td>
                    ))}
                    <td className="px-3 py-2 text-right font-medium">{formatNPR(r.outstandingInPaisa)}</td>
                  </tr>
                ))}
                {data.rows.length === 0 && (
                  <tr>
                    <td colSpan={AGING_BUCKETS.length + 2} className="px-3 py-6 text-center text-sm text-neutral-400">
                      Nothing outstanding as of this date.
                    </td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-neutral-300 font-semibold text-neutral-900">
                  <td className="px-3 py-2" colSpan={AGING_BUCKETS.length + 1}>
                    Total
                  </td>
                  <td className="px-3 py-2 text-right">{formatNPR(data.totalOutstandingInPaisa)}</td>
                </tr>
              </tfoot>
            </table>
            <p className="border-t border-neutral-200 px-4 py-2 text-xs text-neutral-400">
              A negative figure means a running credit balance (an overpayment) rather than an amount owed.
            </p>
          </div>
        )
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

// ---------------------------------------------------------------------------
// Phase 5, Slice 5b — Bank Accounts (CRUD) + Bank Reconciliation (the
// bank-statement checklist). See src/lib/accounting/bank-accounts.ts and
// bank-reconciliation.ts for the underlying rules this UI surfaces.
// ---------------------------------------------------------------------------

type BankAccount = {
  id: string;
  chartOfAccountsId: string;
  bankName: string;
  accountNumber: string | null;
  branchName: string | null;
  notes: string | null;
  isActive: boolean;
  code: string;
  accountName: string;
  createdAt: string;
};

function BankAccountsTab({ slug }: { slug: string }) {
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await apiGet<{ bankAccounts: BankAccount[] }>(`${base(slug)}/accounting/bank-accounts`);
      setAccounts(res.bankAccounts);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load bank accounts.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  async function toggleActive(account: BankAccount) {
    try {
      await apiPatch(`${base(slug)}/accounting/bank-accounts/${account.id}`, { isActive: !account.isActive });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update this bank account.");
    }
  }

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <p className="text-sm text-neutral-500">
        Each bank account here wraps its own ledger account, so it already shows up correctly in Trial
        Balance and the Balance Sheet. With exactly one active bank account, expense/payroll payments and
        reconciliation use it automatically — a picker only appears once a second one exists.
      </p>
      <div className="flex justify-end">
        <button onClick={() => setShowAdd((v) => !v)} className="btn-secondary">
          {showAdd ? "Cancel" : "Add bank account"}
        </button>
      </div>
      {showAdd && (
        <AddBankAccountForm
          slug={slug}
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
                <th className="px-3 py-2">Bank</th>
                <th className="px-3 py-2">Account number</th>
                <th className="px-3 py-2">Branch</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <Fragment key={a.id}>
                  <tr className="border-b border-neutral-100 last:border-0">
                    <td className="px-3 py-2 font-mono text-xs text-neutral-500">{a.code}</td>
                    <td className="px-3 py-2 text-neutral-900">{a.bankName}</td>
                    <td className="px-3 py-2 text-neutral-600">{a.accountNumber || "—"}</td>
                    <td className="px-3 py-2 text-neutral-600">{a.branchName || "—"}</td>
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
                      <div className="flex justify-end gap-3">
                        <button
                          onClick={() => setEditingId(editingId === a.id ? null : a.id)}
                          className="text-xs font-medium text-orange-700 hover:underline"
                        >
                          {editingId === a.id ? "Close" : "Edit"}
                        </button>
                        <button
                          onClick={() => toggleActive(a)}
                          className="text-xs font-medium text-orange-700 hover:underline"
                        >
                          {a.isActive ? "Deactivate" : "Reactivate"}
                        </button>
                      </div>
                    </td>
                  </tr>
                  {editingId === a.id && (
                    <tr key={`${a.id}-edit`} className="border-b border-neutral-100 bg-neutral-50">
                      <td colSpan={6} className="px-3 py-3">
                        <EditBankAccountForm
                          slug={slug}
                          account={a}
                          onSaved={() => {
                            setEditingId(null);
                            load();
                          }}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {accounts.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-sm text-neutral-400">
                    No bank accounts yet — add the first one above.
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

function AddBankAccountForm({ slug, onAdded }: { slug: string; onAdded: () => void }) {
  const [bankName, setBankName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [branchName, setBranchName] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/accounting/bank-accounts`, { bankName, accountNumber, branchName, notes });
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add this bank account.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded-2xl border border-neutral-200 bg-white p-4">
      {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Bank name</span>
          <input required value={bankName} onChange={(e) => setBankName(e.target.value)} className="input" />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Account number (optional)</span>
          <input value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} className="input" />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Branch (optional)</span>
          <input value={branchName} onChange={(e) => setBranchName(e.target.value)} className="input" />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Notes (optional)</span>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} className="input" />
        </label>
      </div>
      <button disabled={saving} className="btn-primary mt-3">
        {saving ? "Adding…" : "Add bank account"}
      </button>
    </form>
  );
}

function EditBankAccountForm({
  slug,
  account,
  onSaved,
}: {
  slug: string;
  account: BankAccount;
  onSaved: () => void;
}) {
  const [bankName, setBankName] = useState(account.bankName);
  const [accountNumber, setAccountNumber] = useState(account.accountNumber ?? "");
  const [branchName, setBranchName] = useState(account.branchName ?? "");
  const [notes, setNotes] = useState(account.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await apiPatch(`${base(slug)}/accounting/bank-accounts/${account.id}`, {
        bankName,
        accountNumber,
        branchName,
        notes,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save changes.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Bank name</span>
          <input required value={bankName} onChange={(e) => setBankName(e.target.value)} className="input" />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Account number</span>
          <input value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} className="input" />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Branch</span>
          <input value={branchName} onChange={(e) => setBranchName(e.target.value)} className="input" />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Notes</span>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} className="input" />
        </label>
      </div>
      <button disabled={saving} className="btn-primary">
        {saving ? "Saving…" : "Save changes"}
      </button>
    </form>
  );
}

type BankReconciliationStatus = "open" | "completed";
type BankReconciliationRow = {
  id: string;
  bankAccountId: string;
  statementDate: string;
  statementClosingBalanceInPaisa: number;
  status: BankReconciliationStatus;
  bookBalanceInPaisa: number | null;
  differenceInPaisa: number | null;
  notes: string | null;
  createdAt: string;
  completedAt: string | null;
};

type BankReconciliationLine = {
  id: string;
  voucherId: string;
  voucherNumber: string;
  voucherType: string;
  voucherDate: string;
  narration: string | null;
  description: string | null;
  debitInPaisa: number;
  creditInPaisa: number;
  cleared: boolean;
};

function BankReconciliationTab({ slug }: { slug: string }) {
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [selectedBankAccountId, setSelectedBankAccountId] = useState("");
  const [reconciliations, setReconciliations] = useState<BankReconciliationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [openReconciliationId, setOpenReconciliationId] = useState<string | null>(null);

  useEffect(() => {
    apiGet<{ bankAccounts: BankAccount[] }>(`${base(slug)}/accounting/bank-accounts`)
      .then((res) => {
        setBankAccounts(res.bankAccounts);
        if (res.bankAccounts.length > 0) setSelectedBankAccountId((v) => v || res.bankAccounts[0].id);
      })
      .catch(() => {});
  }, [slug]);

  async function loadReconciliations() {
    if (!selectedBankAccountId) {
      setReconciliations([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await apiGet<{ reconciliations: BankReconciliationRow[] }>(
        `${base(slug)}/accounting/bank-reconciliations?bankAccountId=${selectedBankAccountId}`,
      );
      setReconciliations(res.reconciliations);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load reconciliations.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadReconciliations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, selectedBankAccountId]);

  if (openReconciliationId) {
    return (
      <BankReconciliationWorkspace
        slug={slug}
        reconciliationId={openReconciliationId}
        onClose={() => {
          setOpenReconciliationId(null);
          loadReconciliations();
        }}
        onDeleted={() => {
          setOpenReconciliationId(null);
          loadReconciliations();
        }}
      />
    );
  }

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {bankAccounts.length === 0 ? (
        <p className="rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-6 text-center text-sm text-neutral-500">
          Add a bank account first, from the Bank Accounts tab.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <label className="block max-w-xs text-sm">
              <span className="mb-1 block text-neutral-600">Bank account</span>
              <select
                value={selectedBankAccountId}
                onChange={(e) => setSelectedBankAccountId(e.target.value)}
                className="input"
              >
                {bankAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.bankName} ({a.code})
                  </option>
                ))}
              </select>
            </label>
            <button onClick={() => setShowNew((v) => !v)} className="btn-secondary">
              {showNew ? "Cancel" : "New reconciliation"}
            </button>
          </div>

          {showNew && (
            <NewBankReconciliationForm
              slug={slug}
              bankAccountId={selectedBankAccountId}
              onCreated={(id) => {
                setShowNew(false);
                setOpenReconciliationId(id);
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
                    <th className="px-3 py-2">Statement date</th>
                    <th className="px-3 py-2 text-right">Closing balance</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2 text-right">Difference</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {reconciliations.map((r) => (
                    <tr key={r.id} className="border-b border-neutral-100 last:border-0">
                      <td className="px-3 py-2 text-neutral-900">{r.statementDate}</td>
                      <td className="px-3 py-2 text-right">{formatNPR(r.statementClosingBalanceInPaisa)}</td>
                      <td className="px-3 py-2">
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                            r.status === "completed"
                              ? "bg-green-100 text-green-800"
                              : "bg-amber-100 text-amber-800"
                          }`}
                        >
                          {r.status === "completed" ? "Completed" : "Open"}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right">
                        {r.differenceInPaisa === null ? (
                          "—"
                        ) : r.differenceInPaisa === 0 ? (
                          <span className="text-green-700">Matched</span>
                        ) : (
                          <span className="text-red-700">{formatNPR(r.differenceInPaisa)}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          onClick={() => setOpenReconciliationId(r.id)}
                          className="text-xs font-medium text-orange-700 hover:underline"
                        >
                          Open
                        </button>
                      </td>
                    </tr>
                  ))}
                  {reconciliations.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-6 text-center text-sm text-neutral-400">
                        No reconciliations yet for this bank account.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function NewBankReconciliationForm({
  slug,
  bankAccountId,
  onCreated,
}: {
  slug: string;
  bankAccountId: string;
  onCreated: (id: string) => void;
}) {
  const [statementDate, setStatementDate] = useState(todayIso());
  const [statementClosingBalance, setStatementClosingBalance] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await apiPost<{ reconciliation: BankReconciliationRow }>(
        `${base(slug)}/accounting/bank-reconciliations`,
        {
          bankAccountId,
          statementDate,
          statementClosingBalance: Number(statementClosingBalance),
        },
      );
      onCreated(res.reconciliation.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create this reconciliation.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded-2xl border border-neutral-200 bg-white p-4">
      {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Statement date</span>
          <input
            required
            type="date"
            value={statementDate}
            onChange={(e) => setStatementDate(e.target.value)}
            className="input"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Statement closing balance (Rs)</span>
          <input
            required
            type="number"
            step="0.01"
            min="0"
            value={statementClosingBalance}
            onChange={(e) => setStatementClosingBalance(e.target.value)}
            className="input"
          />
        </label>
      </div>
      <button disabled={saving} className="btn-primary mt-3">
        {saving ? "Creating…" : "Start reconciliation"}
      </button>
    </form>
  );
}

function BankReconciliationWorkspace({
  slug,
  reconciliationId,
  onClose,
  onDeleted,
}: {
  slug: string;
  reconciliationId: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [reconciliation, setReconciliation] = useState<BankReconciliationRow | null>(null);
  const [lines, setLines] = useState<BankReconciliationLine[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await apiGet<{ reconciliation: BankReconciliationRow; lines: BankReconciliationLine[] }>(
        `${base(slug)}/accounting/bank-reconciliations/${reconciliationId}`,
      );
      setReconciliation(res.reconciliation);
      setLines(res.lines);
      setChecked(new Set(res.lines.filter((l) => l.cleared).map((l) => l.id)));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load this reconciliation.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reconciliationId]);

  const isOpen = reconciliation?.status === "open";
  const clearedTotal = useMemo(
    () =>
      lines
        .filter((l) => checked.has(l.id))
        .reduce((sum, l) => sum + l.debitInPaisa - l.creditInPaisa, 0),
    [lines, checked],
  );

  function toggleLine(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function saveChecklist() {
    setSaving(true);
    setError(null);
    try {
      await apiPatch(`${base(slug)}/accounting/bank-reconciliations/${reconciliationId}`, {
        clearedVoucherLineIds: Array.from(checked),
      });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the checklist.");
    } finally {
      setSaving(false);
    }
  }

  async function complete() {
    setSaving(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/accounting/bank-reconciliations/${reconciliationId}/complete`, {});
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not complete this reconciliation.");
    } finally {
      setSaving(false);
    }
  }

  async function reopen() {
    setSaving(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/accounting/bank-reconciliations/${reconciliationId}/reopen`, {});
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reopen this reconciliation.");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    setSaving(true);
    setError(null);
    try {
      await apiDelete(`${base(slug)}/accounting/bank-reconciliations/${reconciliationId}`);
      onDeleted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete this reconciliation.");
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <button onClick={onClose} className="text-sm font-medium text-orange-700 hover:underline">
        ← Back to reconciliations
      </button>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {loading || !reconciliation ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : (
        <>
          <div className="rounded-2xl border border-neutral-200 bg-white p-4">
            <div className="grid gap-3 text-sm sm:grid-cols-4">
              <div>
                <span className="block text-xs uppercase tracking-wide text-neutral-500">Statement date</span>
                <span className="font-medium text-neutral-900">{reconciliation.statementDate}</span>
              </div>
              <div>
                <span className="block text-xs uppercase tracking-wide text-neutral-500">Statement balance</span>
                <span className="font-medium text-neutral-900">
                  {formatNPR(reconciliation.statementClosingBalanceInPaisa)}
                </span>
              </div>
              <div>
                <span className="block text-xs uppercase tracking-wide text-neutral-500">
                  Cleared so far
                </span>
                <span className="font-medium text-neutral-900">{formatNPR(clearedTotal)}</span>
              </div>
              <div>
                <span className="block text-xs uppercase tracking-wide text-neutral-500">Status</span>
                <span
                  className={`font-medium ${
                    reconciliation.status === "completed" ? "text-green-700" : "text-amber-700"
                  }`}
                >
                  {reconciliation.status === "completed" ? "Completed" : "Open"}
                </span>
              </div>
            </div>
            {reconciliation.status === "completed" && (
              <div
                className={`mt-3 rounded-lg px-3 py-2 text-sm ${
                  reconciliation.differenceInPaisa === 0
                    ? "bg-green-50 text-green-700"
                    : "bg-red-50 text-red-700"
                }`}
              >
                {reconciliation.differenceInPaisa === 0
                  ? "Fully reconciled — the cleared total matches the statement exactly."
                  : `Difference of ${formatNPR(Math.abs(reconciliation.differenceInPaisa ?? 0))} — worth investigating (e.g. an uncleared bank fee).`}
              </div>
            )}
          </div>

          <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500">
                  <th className="px-3 py-2">Cleared</th>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Voucher</th>
                  <th className="px-3 py-2">Narration</th>
                  <th className="px-3 py-2 text-right">Debit</th>
                  <th className="px-3 py-2 text-right">Credit</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.id} className="border-b border-neutral-100 last:border-0">
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        disabled={!isOpen}
                        checked={checked.has(l.id)}
                        onChange={() => toggleLine(l.id)}
                      />
                    </td>
                    <td className="px-3 py-2 text-neutral-500">{l.voucherDate}</td>
                    <td className="px-3 py-2 font-mono text-xs text-neutral-500">{l.voucherNumber}</td>
                    <td className="px-3 py-2 text-neutral-900">{l.narration || l.description || "—"}</td>
                    <td className="px-3 py-2 text-right">{l.debitInPaisa > 0 ? formatNPR(l.debitInPaisa) : "—"}</td>
                    <td className="px-3 py-2 text-right">{l.creditInPaisa > 0 ? formatNPR(l.creditInPaisa) : "—"}</td>
                  </tr>
                ))}
                {lines.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-6 text-center text-sm text-neutral-400">
                      No ledger activity on or before the statement date.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap justify-end gap-2">
            {isOpen ? (
              <>
                <button onClick={remove} disabled={saving} className="btn-secondary">
                  Delete
                </button>
                <button onClick={saveChecklist} disabled={saving} className="btn-secondary">
                  {saving ? "Saving…" : "Save checklist"}
                </button>
                <button onClick={complete} disabled={saving} className="btn-primary">
                  {saving ? "Completing…" : "Complete reconciliation"}
                </button>
              </>
            ) : (
              <button onClick={reopen} disabled={saving} className="btn-secondary">
                {saving ? "Reopening…" : "Reopen for correction"}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fixed Assets (Phase 5, Slice 5d)
// ---------------------------------------------------------------------------

type FundingMethod = "cash" | "bank" | "credit";

const FUNDING_METHOD_LABELS: Record<FundingMethod, string> = {
  cash: "Cash",
  bank: "Bank account",
  credit: "On credit (Accounts Payable)",
};

const MONTH_LABELS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

type FixedAsset = {
  id: string;
  chartOfAccountsId: string;
  name: string;
  category: string | null;
  acquisitionDate: string;
  costInPaisa: number;
  usefulLifeMonths: number;
  salvageValueInPaisa: number;
  accumulatedDepreciationInPaisa: number;
  bookValueInPaisa: number;
  disposedAt: string | null;
  disposalProceedsInPaisa: number | null;
  taxDepreciationPool: "A" | "B" | "C" | "D" | "E" | null;
  notes: string | null;
  code: string;
  accountName: string;
  isActive: boolean;
  createdAt: string;
};

const TAX_DEPRECIATION_POOLS = [
  { value: "A", label: "A — Buildings (5%)" },
  { value: "B", label: "B — Computers/furniture/office (25%)" },
  { value: "C", label: "C — Vehicles (20%)" },
  { value: "D", label: "D — Construction equipment/other (15%)" },
  { value: "E", label: "E — Intangibles (straight-line)" },
] as const;

type DepreciationEntry = {
  id: string;
  fixedAssetId: string;
  voucherId: string;
  periodStart: string;
  periodEnd: string;
  amountInPaisa: number;
  createdAt: string;
};

function FixedAssetsTab({ slug }: { slug: string }) {
  const [assets, setAssets] = useState<FixedAsset[]>([]);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [disposingId, setDisposingId] = useState<string | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const dateSystem = useDateSystem();

  async function load() {
    setLoading(true);
    try {
      const [assetsRes, bankRes] = await Promise.all([
        apiGet<{ fixedAssets: FixedAsset[] }>(`${base(slug)}/accounting/fixed-assets`),
        apiGet<{ bankAccounts: BankAccount[] }>(`${base(slug)}/accounting/bank-accounts`),
      ]);
      setAssets(assetsRes.fixedAssets);
      setBankAccounts(bankRes.bankAccounts.filter((a) => a.isActive));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load fixed assets.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <p className="text-sm text-neutral-500">
        Each fixed asset here wraps its own ledger account under &quot;1900 Fixed Assets&quot;.
        Depreciation here is straight-line, for book/management purposes only. Classify an
        asset&apos;s &quot;Tax pool&quot; below to include it in the separate Nepal Tax
        Depreciation report under Reports — that computation never affects these book figures.
      </p>

      <RunDepreciationPanel slug={slug} onRun={load} />

      <div className="flex justify-end">
        <button onClick={() => setShowAdd((v) => !v)} className="btn-secondary">
          {showAdd ? "Cancel" : "Add fixed asset"}
        </button>
      </div>
      {showAdd && (
        <AddFixedAssetForm
          slug={slug}
          bankAccounts={bankAccounts}
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
                <th className="px-3 py-2">Acquired</th>
                <th className="px-3 py-2 text-right">Cost</th>
                <th className="px-3 py-2 text-right">Accum. depreciation</th>
                <th className="px-3 py-2 text-right">Book value</th>
                <th className="px-3 py-2">Tax pool</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {assets.map((a) => (
                <Fragment key={a.id}>
                  <tr className="border-b border-neutral-100 last:border-0">
                    <td className="px-3 py-2 font-mono text-xs text-neutral-500">{a.code}</td>
                    <td className="px-3 py-2 text-neutral-900">
                      {a.name}
                      {a.category && <span className="ml-2 text-xs text-neutral-400">· {a.category}</span>}
                    </td>
                    <td className="px-3 py-2 text-neutral-600">{formatDate(a.acquisitionDate, dateSystem)}</td>
                    <td className="px-3 py-2 text-right">{formatNPR(a.costInPaisa)}</td>
                    <td className="px-3 py-2 text-right">{formatNPR(a.accumulatedDepreciationInPaisa)}</td>
                    <td className="px-3 py-2 text-right font-medium">{formatNPR(a.bookValueInPaisa)}</td>
                    <td className="px-3 py-2">
                      <TaxDepreciationPoolSelect
                        slug={slug}
                        fixedAssetId={a.id}
                        value={a.taxDepreciationPool}
                        onChanged={(pool) =>
                          setAssets((prev) => prev.map((x) => (x.id === a.id ? { ...x, taxDepreciationPool: pool } : x)))
                        }
                      />
                    </td>
                    <td className="px-3 py-2">
                      {a.disposedAt ? (
                        <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-500">
                          Disposed
                        </span>
                      ) : (
                        <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">
                          Active
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex justify-end gap-3">
                        <button
                          onClick={() => setHistoryId(historyId === a.id ? null : a.id)}
                          className="text-xs font-medium text-orange-700 hover:underline"
                        >
                          {historyId === a.id ? "Close" : "History"}
                        </button>
                        {!a.disposedAt && (
                          <button
                            onClick={() => setDisposingId(disposingId === a.id ? null : a.id)}
                            className="text-xs font-medium text-orange-700 hover:underline"
                          >
                            {disposingId === a.id ? "Cancel" : "Dispose"}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {historyId === a.id && (
                    <tr className="border-b border-neutral-100 bg-neutral-50">
                      <td colSpan={9} className="px-3 py-3">
                        <DepreciationHistory slug={slug} fixedAssetId={a.id} />
                      </td>
                    </tr>
                  )}
                  {disposingId === a.id && (
                    <tr className="border-b border-neutral-100 bg-neutral-50">
                      <td colSpan={9} className="px-3 py-3">
                        <DisposeFixedAssetForm
                          slug={slug}
                          asset={a}
                          bankAccounts={bankAccounts}
                          onDisposed={() => {
                            setDisposingId(null);
                            load();
                          }}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {assets.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-6 text-center text-sm text-neutral-400">
                    No fixed assets yet — add the first one above.
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

/**
 * Phase 6, Slice 6e — the only editable thing about an existing fixed
 * asset: which Nepal tax-depreciation pool it belongs to (or none). Saves
 * immediately on change (no separate save button) since this is a single,
 * low-stakes classification field, not a form.
 */
function TaxDepreciationPoolSelect({
  slug,
  fixedAssetId,
  value,
  onChanged,
}: {
  slug: string;
  fixedAssetId: string;
  value: FixedAsset["taxDepreciationPool"];
  onChanged: (pool: FixedAsset["taxDepreciationPool"]) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleChange(next: string) {
    const pool = (next || null) as FixedAsset["taxDepreciationPool"];
    setSaving(true);
    setError(null);
    try {
      await apiPatch(`${base(slug)}/accounting/fixed-assets/${fixedAssetId}`, { taxDepreciationPool: pool });
      onChanged(pool);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <select
        className="input py-1 text-xs"
        value={value ?? ""}
        disabled={saving}
        onChange={(e) => handleChange(e.target.value)}
      >
        <option value="">Unclassified</option>
        {TAX_DEPRECIATION_POOLS.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
      </select>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

function RunDepreciationPanel({ slug, onRun }: { slug: string; onRun: () => void }) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    voucher: { voucherNumber: string } | null;
    entries: Array<{ fixedAssetName: string; amountInPaisa: number }>;
    totalInPaisa: number;
  } | null>(null);

  async function run() {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await apiPost<{
        voucher: { voucherNumber: string } | null;
        entries: Array<{ fixedAssetName: string; amountInPaisa: number }>;
        totalInPaisa: number;
      }>(`${base(slug)}/accounting/fixed-assets/run-depreciation`, { year, month });
      setResult(res);
      onRun();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not run depreciation.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="rounded-2xl border border-neutral-200 bg-white p-4">
      <p className="text-sm font-medium text-neutral-900">Run Depreciation</p>
      <p className="mt-1 text-xs text-neutral-500">
        Charges every active asset&apos;s straight-line depreciation through the end of the chosen
        month. Safe to run more than once — an asset already caught up through that date is simply
        skipped.
      </p>
      {error && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Month</span>
          <select value={month} onChange={(e) => setMonth(Number(e.target.value))} className="input !w-auto">
            {MONTH_LABELS.map((label, i) => (
              <option key={label} value={i + 1}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Year</span>
          <input
            type="number"
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="input !w-24"
          />
        </label>
        <button disabled={running} onClick={run} className="btn-primary">
          {running ? "Running…" : `Run Depreciation for ${MONTH_LABELS[month - 1]} ${year}`}
        </button>
      </div>
      {result && (
        <div className="mt-3 rounded-lg bg-neutral-50 px-3 py-2 text-sm">
          {result.voucher ? (
            <>
              <p className="font-medium text-neutral-900">
                Posted {result.voucher.voucherNumber} — {formatNPR(result.totalInPaisa)} across{" "}
                {result.entries.length} asset{result.entries.length === 1 ? "" : "s"}.
              </p>
              <ul className="mt-1 space-y-0.5 text-xs text-neutral-500">
                {result.entries.map((e, i) => (
                  <li key={i}>
                    {e.fixedAssetName}: {formatNPR(e.amountInPaisa)}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-neutral-500">Nothing to depreciate for this period.</p>
          )}
        </div>
      )}
    </div>
  );
}

function DepreciationHistory({ slug, fixedAssetId }: { slug: string; fixedAssetId: string }) {
  const [entries, setEntries] = useState<DepreciationEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<{ depreciationEntries: DepreciationEntry[] }>(`${base(slug)}/accounting/fixed-assets/${fixedAssetId}`)
      .then((res) => setEntries(res.depreciationEntries))
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load depreciation history."));
  }, [slug, fixedAssetId]);

  if (error) return <p className="text-sm text-red-700">{error}</p>;
  if (!entries) return <p className="text-sm text-neutral-500">Loading…</p>;
  if (entries.length === 0) return <p className="text-sm text-neutral-400">No depreciation posted yet.</p>;

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs uppercase tracking-wide text-neutral-500">
          <th className="py-1">Period</th>
          <th className="py-1 text-right">Amount</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => (
          <tr key={e.id} className="border-t border-neutral-100">
            <td className="py-1 text-neutral-600">
              {e.periodStart} – {e.periodEnd}
            </td>
            <td className="py-1 text-right">{formatNPR(e.amountInPaisa)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AddFixedAssetForm({
  slug,
  bankAccounts,
  onAdded,
}: {
  slug: string;
  bankAccounts: BankAccount[];
  onAdded: () => void;
}) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [acquisitionDate, setAcquisitionDate] = useState(todayIso());
  const [cost, setCost] = useState("");
  const [usefulLifeMonths, setUsefulLifeMonths] = useState("");
  const [salvageValue, setSalvageValue] = useState("0");
  const [fundingMethod, setFundingMethod] = useState<FundingMethod>("cash");
  const [bankAccountId, setBankAccountId] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsBankAccountChoice = fundingMethod === "bank" && bankAccounts.length > 1;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/accounting/fixed-assets`, {
        name,
        category: category || undefined,
        acquisitionDate,
        cost: Number(cost),
        usefulLifeMonths: Number(usefulLifeMonths),
        salvageValue: Number(salvageValue || 0),
        fundingMethod,
        bankAccountId: needsBankAccountChoice && bankAccountId ? bankAccountId : undefined,
        notes: notes || undefined,
      });
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add this fixed asset.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded-2xl border border-neutral-200 bg-white p-4">
      {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Name</span>
          <input required value={name} onChange={(e) => setName(e.target.value)} className="input" />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Category (optional)</span>
          <input
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="input"
            placeholder="e.g. Kitchen Equipment"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Acquisition date</span>
          <input
            required
            type="date"
            value={acquisitionDate}
            onChange={(e) => setAcquisitionDate(e.target.value)}
            className="input"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Cost (Rs)</span>
          <input
            required
            type="number"
            min={0.01}
            step="0.01"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
            className="input"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Useful life (months)</span>
          <input
            required
            type="number"
            min={1}
            step="1"
            value={usefulLifeMonths}
            onChange={(e) => setUsefulLifeMonths(e.target.value)}
            className="input"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Salvage value (Rs, optional)</span>
          <input
            type="number"
            min={0}
            step="0.01"
            value={salvageValue}
            onChange={(e) => setSalvageValue(e.target.value)}
            className="input"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Funded by</span>
          <select
            value={fundingMethod}
            onChange={(e) => {
              setFundingMethod(e.target.value as FundingMethod);
              setBankAccountId("");
            }}
            className="input"
          >
            {(Object.keys(FUNDING_METHOD_LABELS) as FundingMethod[]).map((m) => (
              <option key={m} value={m}>
                {FUNDING_METHOD_LABELS[m]}
              </option>
            ))}
          </select>
        </label>
        {needsBankAccountChoice && (
          <label className="text-sm">
            <span className="mb-1 block text-neutral-600">Bank account</span>
            <select value={bankAccountId} onChange={(e) => setBankAccountId(e.target.value)} className="input">
              <option value="">Choose bank account…</option>
              {bankAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.bankName} ({a.code})
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="text-sm sm:col-span-2 lg:col-span-3">
          <span className="mb-1 block text-neutral-600">Notes (optional)</span>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} className="input" />
        </label>
      </div>
      <button disabled={saving || (needsBankAccountChoice && !bankAccountId)} className="btn-primary mt-3">
        {saving ? "Adding…" : "Add fixed asset"}
      </button>
    </form>
  );
}

function DisposeFixedAssetForm({
  slug,
  asset,
  bankAccounts,
  onDisposed,
}: {
  slug: string;
  asset: FixedAsset;
  bankAccounts: BankAccount[];
  onDisposed: () => void;
}) {
  const [disposalDate, setDisposalDate] = useState(todayIso());
  const [proceeds, setProceeds] = useState("0");
  const [proceedsMethod, setProceedsMethod] = useState<"cash" | "bank">("cash");
  const [bankAccountId, setBankAccountId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<number | null>(null);
  const hasProceeds = Number(proceeds || 0) > 0;
  const needsBankAccountChoice = hasProceeds && proceedsMethod === "bank" && bankAccounts.length > 1;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await apiPost<{ gainOrLossInPaisa: number }>(
        `${base(slug)}/accounting/fixed-assets/${asset.id}/dispose`,
        {
          disposalDate,
          proceeds: Number(proceeds || 0),
          proceedsMethod: hasProceeds ? proceedsMethod : undefined,
          bankAccountId: needsBankAccountChoice && bankAccountId ? bankAccountId : undefined,
        },
      );
      setResult(res.gainOrLossInPaisa);
      onDisposed();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not dispose of this asset.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-sm text-neutral-600">
        Book value today: <span className="font-medium">{formatNPR(asset.bookValueInPaisa)}</span>
      </p>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {result !== null && (
        <p className={`rounded-lg px-3 py-2 text-sm ${result === 0 ? "bg-neutral-100 text-neutral-600" : result > 0 ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}>
          {result === 0
            ? "No gain or loss — proceeds matched book value exactly."
            : result > 0
              ? `Gain of ${formatNPR(result)} recorded.`
              : `Loss of ${formatNPR(-result)} recorded.`}
        </p>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Disposal date</span>
          <input
            required
            type="date"
            value={disposalDate}
            onChange={(e) => setDisposalDate(e.target.value)}
            className="input"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Proceeds received (Rs, optional)</span>
          <input
            type="number"
            min={0}
            step="0.01"
            value={proceeds}
            onChange={(e) => setProceeds(e.target.value)}
            className="input"
          />
        </label>
        {hasProceeds && (
          <label className="text-sm">
            <span className="mb-1 block text-neutral-600">Received into</span>
            <select
              value={proceedsMethod}
              onChange={(e) => {
                setProceedsMethod(e.target.value as "cash" | "bank");
                setBankAccountId("");
              }}
              className="input"
            >
              <option value="cash">Cash</option>
              <option value="bank">Bank account</option>
            </select>
          </label>
        )}
        {needsBankAccountChoice && (
          <label className="text-sm">
            <span className="mb-1 block text-neutral-600">Bank account</span>
            <select value={bankAccountId} onChange={(e) => setBankAccountId(e.target.value)} className="input">
              <option value="">Choose bank account…</option>
              {bankAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.bankName} ({a.code})
                </option>
              ))}
            </select>
          </label>
        )}
        <button disabled={saving || (needsBankAccountChoice && !bankAccountId)} className="btn-primary">
          {saving ? "Disposing…" : "Dispose"}
        </button>
      </div>
      <p className="text-xs text-neutral-400">
        Removes the asset&apos;s full cost and its accumulated depreciation from the books; any
        difference between proceeds and book value posts as a gain or loss.
      </p>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Loans (Phase 5, Slice 5e)
// ---------------------------------------------------------------------------

type LoanFundingMethod = "cash" | "bank";

const LOAN_FUNDING_METHOD_LABELS: Record<LoanFundingMethod, string> = {
  cash: "Cash",
  bank: "Bank account",
};

type Loan = {
  id: string;
  chartOfAccountsId: string;
  lenderName: string;
  principalInPaisa: number;
  interestRateBasisPoints: number | null;
  startDate: string;
  termMonths: number | null;
  outstandingPrincipalInPaisa: number;
  status: "active" | "closed";
  closedAt: string | null;
  notes: string | null;
  code: string;
  accountName: string;
  isActive: boolean;
  createdAt: string;
};

type LoanPayment = {
  id: string;
  loanId: string;
  voucherId: string;
  paymentDate: string;
  principalInPaisa: number;
  interestInPaisa: number;
  notes: string | null;
  createdAt: string;
};

function LoansTab({ slug }: { slug: string }) {
  const [loans, setLoans] = useState<Loan[]>([]);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [repayingId, setRepayingId] = useState<string | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const dateSystem = useDateSystem();

  async function load() {
    setLoading(true);
    try {
      const [loansRes, bankRes] = await Promise.all([
        apiGet<{ loans: Loan[] }>(`${base(slug)}/accounting/loans`),
        apiGet<{ bankAccounts: BankAccount[] }>(`${base(slug)}/accounting/bank-accounts`),
      ]);
      setLoans(loansRes.loans);
      setBankAccounts(bankRes.bankAccounts.filter((a) => a.isActive));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load loans.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <p className="text-sm text-neutral-500">
        Each loan here wraps its own ledger account under &quot;2400 Loans Payable&quot;. Every
        repayment&apos;s principal/interest split is entered manually — there is no
        amortization-schedule calculator.
      </p>

      <div className="flex justify-end">
        <button onClick={() => setShowAdd((v) => !v)} className="btn-secondary">
          {showAdd ? "Cancel" : "Record a loan"}
        </button>
      </div>
      {showAdd && (
        <AddLoanForm
          slug={slug}
          bankAccounts={bankAccounts}
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
                <th className="px-3 py-2">Lender</th>
                <th className="px-3 py-2">Started</th>
                <th className="px-3 py-2 text-right">Principal</th>
                <th className="px-3 py-2 text-right">Outstanding</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {loans.map((l) => (
                <Fragment key={l.id}>
                  <tr className="border-b border-neutral-100 last:border-0">
                    <td className="px-3 py-2 font-mono text-xs text-neutral-500">{l.code}</td>
                    <td className="px-3 py-2 text-neutral-900">
                      {l.lenderName}
                      {l.interestRateBasisPoints != null && (
                        <span className="ml-2 text-xs text-neutral-400">
                          · {(l.interestRateBasisPoints / 100).toFixed(2)}%
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-neutral-600">{formatDate(l.startDate, dateSystem)}</td>
                    <td className="px-3 py-2 text-right">{formatNPR(l.principalInPaisa)}</td>
                    <td className="px-3 py-2 text-right font-medium">
                      {formatNPR(l.outstandingPrincipalInPaisa)}
                    </td>
                    <td className="px-3 py-2">
                      {l.status === "closed" ? (
                        <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-500">
                          Closed
                        </span>
                      ) : (
                        <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">
                          Active
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex justify-end gap-3">
                        <button
                          onClick={() => setHistoryId(historyId === l.id ? null : l.id)}
                          className="text-xs font-medium text-orange-700 hover:underline"
                        >
                          {historyId === l.id ? "Close" : "History"}
                        </button>
                        {l.status === "active" && (
                          <button
                            onClick={() => setRepayingId(repayingId === l.id ? null : l.id)}
                            className="text-xs font-medium text-orange-700 hover:underline"
                          >
                            {repayingId === l.id ? "Cancel" : "Record repayment"}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {historyId === l.id && (
                    <tr className="border-b border-neutral-100 bg-neutral-50">
                      <td colSpan={7} className="px-3 py-3">
                        <LoanPaymentHistory slug={slug} loanId={l.id} />
                      </td>
                    </tr>
                  )}
                  {repayingId === l.id && (
                    <tr className="border-b border-neutral-100 bg-neutral-50">
                      <td colSpan={7} className="px-3 py-3">
                        <RepayLoanForm
                          slug={slug}
                          loan={l}
                          bankAccounts={bankAccounts}
                          onRepaid={() => {
                            setRepayingId(null);
                            load();
                          }}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {loans.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-sm text-neutral-400">
                    No loans yet — record the first one above.
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

function LoanPaymentHistory({ slug, loanId }: { slug: string; loanId: string }) {
  const [payments, setPayments] = useState<LoanPayment[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<{ payments: LoanPayment[] }>(`${base(slug)}/accounting/loans/${loanId}`)
      .then((res) => setPayments(res.payments))
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load repayment history."));
  }, [slug, loanId]);

  if (error) return <p className="text-sm text-red-700">{error}</p>;
  if (!payments) return <p className="text-sm text-neutral-500">Loading…</p>;
  if (payments.length === 0) return <p className="text-sm text-neutral-400">No repayments recorded yet.</p>;

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs uppercase tracking-wide text-neutral-500">
          <th className="py-1">Date</th>
          <th className="py-1 text-right">Principal</th>
          <th className="py-1 text-right">Interest</th>
        </tr>
      </thead>
      <tbody>
        {payments.map((p) => (
          <tr key={p.id} className="border-t border-neutral-100">
            <td className="py-1 text-neutral-600">{p.paymentDate}</td>
            <td className="py-1 text-right">{formatNPR(p.principalInPaisa)}</td>
            <td className="py-1 text-right">{formatNPR(p.interestInPaisa)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AddLoanForm({
  slug,
  bankAccounts,
  onAdded,
}: {
  slug: string;
  bankAccounts: BankAccount[];
  onAdded: () => void;
}) {
  const [lenderName, setLenderName] = useState("");
  const [principal, setPrincipal] = useState("");
  const [interestRatePercent, setInterestRatePercent] = useState("");
  const [startDate, setStartDate] = useState(todayIso());
  const [termMonths, setTermMonths] = useState("");
  const [fundingMethod, setFundingMethod] = useState<LoanFundingMethod>("cash");
  const [bankAccountId, setBankAccountId] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsBankAccountChoice = fundingMethod === "bank" && bankAccounts.length > 1;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/accounting/loans`, {
        lenderName,
        principal: Number(principal),
        interestRatePercent: interestRatePercent ? Number(interestRatePercent) : undefined,
        startDate,
        termMonths: termMonths ? Number(termMonths) : undefined,
        fundingMethod,
        bankAccountId: needsBankAccountChoice && bankAccountId ? bankAccountId : undefined,
        notes: notes || undefined,
      });
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not record this loan.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded-2xl border border-neutral-200 bg-white p-4">
      {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Lender name</span>
          <input required value={lenderName} onChange={(e) => setLenderName(e.target.value)} className="input" />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Principal (Rs)</span>
          <input
            required
            type="number"
            min={0.01}
            step="0.01"
            value={principal}
            onChange={(e) => setPrincipal(e.target.value)}
            className="input"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Interest rate (%, optional)</span>
          <input
            type="number"
            min={0}
            step="0.01"
            value={interestRatePercent}
            onChange={(e) => setInterestRatePercent(e.target.value)}
            className="input"
            placeholder="For display only"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Start date</span>
          <input
            required
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="input"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Term (months, optional)</span>
          <input
            type="number"
            min={1}
            step="1"
            value={termMonths}
            onChange={(e) => setTermMonths(e.target.value)}
            className="input"
            placeholder="For display only"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Received into</span>
          <select
            value={fundingMethod}
            onChange={(e) => {
              setFundingMethod(e.target.value as LoanFundingMethod);
              setBankAccountId("");
            }}
            className="input"
          >
            {(Object.keys(LOAN_FUNDING_METHOD_LABELS) as LoanFundingMethod[]).map((m) => (
              <option key={m} value={m}>
                {LOAN_FUNDING_METHOD_LABELS[m]}
              </option>
            ))}
          </select>
        </label>
        {needsBankAccountChoice && (
          <label className="text-sm">
            <span className="mb-1 block text-neutral-600">Bank account</span>
            <select value={bankAccountId} onChange={(e) => setBankAccountId(e.target.value)} className="input">
              <option value="">Choose bank account…</option>
              {bankAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.bankName} ({a.code})
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="text-sm sm:col-span-2 lg:col-span-3">
          <span className="mb-1 block text-neutral-600">Notes (optional)</span>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} className="input" />
        </label>
      </div>
      <p className="mt-2 text-xs text-neutral-400">
        Interest rate and term are shown for reference only — every repayment&apos;s
        principal/interest split is entered by hand.
      </p>
      <button disabled={saving || (needsBankAccountChoice && !bankAccountId)} className="btn-primary mt-3">
        {saving ? "Recording…" : "Record loan"}
      </button>
    </form>
  );
}

function RepayLoanForm({
  slug,
  loan,
  bankAccounts,
  onRepaid,
}: {
  slug: string;
  loan: Loan;
  bankAccounts: BankAccount[];
  onRepaid: () => void;
}) {
  const [paymentDate, setPaymentDate] = useState(todayIso());
  const [principal, setPrincipal] = useState("0");
  const [interest, setInterest] = useState("0");
  const [paymentMethod, setPaymentMethod] = useState<LoanFundingMethod>("cash");
  const [bankAccountId, setBankAccountId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsBankAccountChoice = paymentMethod === "bank" && bankAccounts.length > 1;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/accounting/loans/${loan.id}/repay`, {
        paymentDate,
        principal: Number(principal || 0),
        interest: Number(interest || 0),
        paymentMethod,
        bankAccountId: needsBankAccountChoice && bankAccountId ? bankAccountId : undefined,
      });
      onRepaid();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not record this repayment.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-sm text-neutral-600">
        Outstanding balance: <span className="font-medium">{formatNPR(loan.outstandingPrincipalInPaisa)}</span>
      </p>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Payment date</span>
          <input
            required
            type="date"
            value={paymentDate}
            onChange={(e) => setPaymentDate(e.target.value)}
            className="input"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Principal (Rs)</span>
          <input
            type="number"
            min={0}
            step="0.01"
            value={principal}
            onChange={(e) => setPrincipal(e.target.value)}
            className="input"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Interest (Rs)</span>
          <input
            type="number"
            min={0}
            step="0.01"
            value={interest}
            onChange={(e) => setInterest(e.target.value)}
            className="input"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Paid from</span>
          <select
            value={paymentMethod}
            onChange={(e) => {
              setPaymentMethod(e.target.value as LoanFundingMethod);
              setBankAccountId("");
            }}
            className="input"
          >
            {(Object.keys(LOAN_FUNDING_METHOD_LABELS) as LoanFundingMethod[]).map((m) => (
              <option key={m} value={m}>
                {LOAN_FUNDING_METHOD_LABELS[m]}
              </option>
            ))}
          </select>
        </label>
        {needsBankAccountChoice && (
          <label className="text-sm">
            <span className="mb-1 block text-neutral-600">Bank account</span>
            <select value={bankAccountId} onChange={(e) => setBankAccountId(e.target.value)} className="input">
              <option value="">Choose bank account…</option>
              {bankAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.bankName} ({a.code})
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          disabled={
            saving ||
            (needsBankAccountChoice && !bankAccountId) ||
            (Number(principal || 0) <= 0 && Number(interest || 0) <= 0)
          }
          className="btn-primary"
        >
          {saving ? "Recording…" : "Record repayment"}
        </button>
      </div>
      <p className="text-xs text-neutral-400">
        The principal/interest split is entered by hand — this module never computes it from the
        loan&apos;s own interest rate.
      </p>
    </form>
  );
}
