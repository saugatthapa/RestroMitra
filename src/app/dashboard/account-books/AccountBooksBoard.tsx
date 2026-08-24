"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPost, ApiError } from "@/lib/api-client";
import { localDateIso } from "@/lib/local-date";
import { formatNPR } from "@/lib/money";
import { useDateSystem, type DateSystem } from "@/lib/date-system";
import { formatDate, formatBsHint, formatBsMonthYear, formatBsYear, formatTimeOfDay } from "@/lib/nepali-date";
import {
  LEDGER_CATEGORY_LABELS,
  LEDGER_DIRECTION_LABELS,
  MANUAL_LEDGER_CATEGORIES,
  type LedgerCategory,
  type LedgerDirection,
} from "@/lib/ledger-categories";
import { useActiveBranch } from "@/lib/branch-context";
import { PAYMENT_METHOD_LABELS, type PaymentMethod } from "@/lib/payments";

type LedgerEntry = {
  id: string;
  entryDate: string;
  direction: LedgerDirection;
  category: LedgerCategory;
  amountInPaisa: number;
  counterpartyName: string | null;
  description: string;
  note: string | null;
  dueStatus: "none" | "outstanding" | "settled";
  settledAmountInPaisa: number;
  createdAt: string;
};

type Totals = {
  creditInPaisa: number;
  debitInPaisa: number;
  netInPaisa: number;
  outstandingCreditInPaisa: number;
  outstandingDebitInPaisa: number;
};

type DayBook = { date: string; entries: LedgerEntry[]; totals: Totals };
type RollupRow = { key: string } & Totals;
type Rollup = { granularity: "month" | "year"; from: string; to: string; rows: RollupRow[]; totals: Totals };
type OutstandingDue = LedgerEntry & { remainingInPaisa: number };

type Tab = "day" | "month" | "year" | "due" | "reconcile";

function base(slug: string) {
  return `/api/restaurants/${slug}`;
}

function todayIso() {
  return localDateIso();
}

function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function shiftMonth(iso: string, months: number): string {
  const [y, m] = iso.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + months, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

function shiftYear(iso: string, years: number): string {
  const [y, m, day] = iso.split("-");
  return `${Number(y) + years}-${m}-${day}`;
}

// Both label helpers take the active `system` so the day book, rollup
// heading, and rollup row labels all follow the header's AD/BS toggle —
// the underlying `iso` values stay Gregorian throughout (that's what the
// ledger API groups by), only the display text changes.
function formatDayLabel(iso: string, system: DateSystem): string {
  if (system === "BS") {
    return formatDate(`${iso}T00:00:00`, "BS");
  }
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-NP", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

function formatMonthLabel(iso: string, system: DateSystem): string {
  if (system === "BS") {
    // Approximation: BS months don't align with Gregorian month
    // boundaries, so this shows the BS month/year the 1st of the
    // Gregorian month falls in rather than re-bucketing the underlying
    // rollup (which the API still groups by Gregorian month).
    return formatBsMonthYear(iso);
  }
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-NP", { month: "long", year: "numeric" });
}

export function AccountBooksBoard({ slug, canManage }: { slug: string; canManage: boolean }) {
  const [tab, setTab] = useState<Tab>("day");
  const [anchorDate, setAnchorDate] = useState(todayIso());
  const [dayBook, setDayBook] = useState<DayBook | null>(null);
  const [rollup, setRollup] = useState<Rollup | null>(null);
  const [outstandingDues, setOutstandingDues] = useState<OutstandingDue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);

  async function load() {
    // "reconcile" is its own self-contained view (ReconciliationView below)
    // with its own data source (payments, not ledger entries) and its own
    // loading/fetch lifecycle — nothing here to fetch for it. Force
    // `loading` false so a mid-flight switch away from another tab doesn't
    // leave this view stuck showing "Loading…" until that fetch settles.
    if (tab === "reconcile") {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const granularity = tab === "due" ? "day" : tab;
      const res = await apiGet<{
        book: DayBook | Rollup;
        outstandingDues: OutstandingDue[];
      }>(`${base(slug)}/ledger/summary?granularity=${granularity}&date=${anchorDate}`);
      if (granularity === "day") {
        setDayBook(res.book as DayBook);
        setRollup(null);
      } else {
        setRollup(res.book as Rollup);
        setDayBook(null);
      }
      setOutstandingDues(res.outstandingDues);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load the ledger.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, tab, anchorDate]);

  if (!canManage) {
    return (
      <p className="text-sm text-neutral-400">
        Your role doesn&apos;t have access to Account Books.
      </p>
    );
  }

  const totalOutstandingReceivable = outstandingDues
    .filter((d) => d.direction === "credit")
    .reduce((sum, d) => sum + d.remainingInPaisa, 0);
  const totalOutstandingPayable = outstandingDues
    .filter((d) => d.direction === "debit")
    .reduce((sum, d) => sum + d.remainingInPaisa, 0);

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 rounded-full border border-neutral-200 bg-white p-1">
          {(["day", "month", "year", "due", "reconcile"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-full px-3 py-1.5 text-xs font-medium capitalize transition ${
                tab === t ? "bg-orange-600 text-white" : "text-neutral-600 hover:bg-neutral-50"
              }`}
            >
              {t === "due" ? "Due tracking" : t === "reconcile" ? "Reconciliation" : `${t} book`}
            </button>
          ))}
        </div>
        {tab !== "reconcile" && (
          <button onClick={() => setShowAddForm((v) => !v)} className="btn-primary">
            {showAddForm ? "Cancel" : "+ Add entry"}
          </button>
        )}
      </div>

      {(totalOutstandingReceivable > 0 || totalOutstandingPayable > 0) && (
        <div className="flex flex-wrap gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm">
          {totalOutstandingReceivable > 0 && (
            <p className="text-amber-800">
              <span className="font-semibold">{formatNPR(totalOutstandingReceivable)}</span> owed to
              you (uncollected sales)
            </p>
          )}
          {totalOutstandingPayable > 0 && (
            <p className="text-amber-800">
              <span className="font-semibold">{formatNPR(totalOutstandingPayable)}</span> you owe
              (unpaid dues)
            </p>
          )}
        </div>
      )}

      {showAddForm && (
        <AddEntryForm
          slug={slug}
          defaultDate={anchorDate.length === 10 ? anchorDate : todayIso()}
          onAdded={() => {
            setShowAddForm(false);
            load();
          }}
        />
      )}

      {loading ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : tab === "day" ? (
        <DayBookView
          slug={slug}
          book={dayBook}
          anchorDate={anchorDate}
          onNavigate={(days) => setAnchorDate(shiftDate(anchorDate, days))}
          onDateChange={setAnchorDate}
          onSettled={load}
        />
      ) : tab === "due" ? (
        <DueTrackingView slug={slug} dues={outstandingDues} onSettled={load} />
      ) : tab === "reconcile" ? (
        <ReconciliationView slug={slug} />
      ) : (
        <RollupView
          rollup={rollup}
          granularity={tab}
          anchorDate={anchorDate}
          onNavigate={(delta) =>
            setAnchorDate(tab === "month" ? shiftMonth(anchorDate, delta) : shiftYear(anchorDate, delta))
          }
          onDrillDown={(key) => {
            if (tab === "month") {
              setAnchorDate(key);
              setTab("day");
            } else {
              setAnchorDate(`${key}-01`);
              setTab("month");
            }
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Totals strip
// ---------------------------------------------------------------------------

function TotalsStrip({ totals }: { totals: Totals }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      <Stat label="Cash in" value={formatNPR(totals.creditInPaisa)} tone="green" />
      <Stat label="Cash out" value={formatNPR(totals.debitInPaisa)} tone="red" />
      <Stat
        label="Net"
        value={formatNPR(totals.netInPaisa)}
        tone={totals.netInPaisa >= 0 ? "green" : "red"}
      />
      <Stat label="On credit (in)" value={formatNPR(totals.outstandingCreditInPaisa)} tone="amber" />
      <Stat label="On credit (out)" value={formatNPR(totals.outstandingDebitInPaisa)} tone="amber" />
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: "green" | "red" | "amber" }) {
  const toneClass =
    tone === "green" ? "text-green-700" : tone === "red" ? "text-red-700" : "text-amber-700";
  return (
    <div className="rounded-xl bg-neutral-50 px-3 py-2">
      <p className="text-xs text-neutral-500">{label}</p>
      <p className={`text-base font-semibold ${toneClass}`}>{value}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Day book
// ---------------------------------------------------------------------------

function DayBookView({
  slug,
  book,
  anchorDate,
  onNavigate,
  onDateChange,
  onSettled,
}: {
  slug: string;
  book: DayBook | null;
  anchorDate: string;
  onNavigate: (days: number) => void;
  onDateChange: (date: string) => void;
  onSettled: () => void;
}) {
  const dateSystem = useDateSystem();
  if (!book) return null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => onNavigate(-1)} className="btn-secondary px-2 py-1 text-xs">
          ←
        </button>
        <input
          type="date"
          value={anchorDate}
          onChange={(e) => onDateChange(e.target.value)}
          className="input w-auto"
        />
        {dateSystem === "BS" && (
          <span className="text-xs text-neutral-400">{formatBsHint(anchorDate)}</span>
        )}
        <button onClick={() => onNavigate(1)} className="btn-secondary px-2 py-1 text-xs">
          →
        </button>
        <button onClick={() => onDateChange(todayIso())} className="text-xs text-orange-700 hover:underline">
          Today
        </button>
      </div>

      <TotalsStrip totals={book.totals} />

      <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="px-3 py-2">Time</th>
              <th className="px-3 py-2">Category</th>
              <th className="px-3 py-2">Description</th>
              <th className="px-3 py-2">Counterparty</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2 text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {book.entries.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-neutral-400">
                  No entries for {formatDayLabel(book.date, dateSystem)}.
                </td>
              </tr>
            )}
            {book.entries.map((entry) => (
              <EntryRow key={entry.id} slug={slug} entry={entry} onSettled={onSettled} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EntryRow({ slug, entry, onSettled }: { slug: string; entry: LedgerEntry; onSettled: () => void }) {
  const [showSettle, setShowSettle] = useState(false);
  const remaining = entry.amountInPaisa - entry.settledAmountInPaisa;

  return (
    <>
      <tr className="border-t border-neutral-100">
        <td className="px-3 py-2 text-neutral-500">{formatTimeOfDay(entry.createdAt)}</td>
        <td className="px-3 py-2">{LEDGER_CATEGORY_LABELS[entry.category]}</td>
        <td className="px-3 py-2 text-neutral-700">{entry.description}</td>
        <td className="px-3 py-2 text-neutral-500">{entry.counterpartyName || "—"}</td>
        <td className="px-3 py-2">
          {entry.dueStatus === "outstanding" ? (
            <button
              onClick={() => setShowSettle((v) => !v)}
              className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 hover:bg-amber-200"
            >
              On credit — settle
            </button>
          ) : entry.dueStatus === "settled" ? (
            <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-500">
              Settled
            </span>
          ) : (
            <span className="text-xs text-neutral-400">Cash</span>
          )}
        </td>
        <td
          className={`px-3 py-2 text-right font-medium ${
            entry.direction === "credit" ? "text-green-700" : "text-red-700"
          }`}
        >
          {entry.direction === "credit" ? "+" : "−"}
          {formatNPR(entry.amountInPaisa)}
        </td>
      </tr>
      {showSettle && (
        <tr className="border-t border-neutral-100 bg-amber-50/50">
          <td colSpan={6} className="px-3 py-2">
            <SettleForm
              slug={slug}
              entryId={entry.id}
              remainingInPaisa={remaining}
              onSettled={() => {
                setShowSettle(false);
                onSettled();
              }}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function SettleForm({
  slug,
  entryId,
  remainingInPaisa,
  onSettled,
}: {
  slug: string;
  entryId: string;
  remainingInPaisa: number;
  onSettled: () => void;
}) {
  const [amount, setAmount] = useState(String(remainingInPaisa / 100));
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/ledger/${entryId}/settle`, {
        amount: Number(amount),
        note: note || undefined,
      });
      onSettled();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not settle this due.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
      {error && <p className="w-full text-xs text-red-700">{error}</p>}
      <label className="text-xs">
        <span className="mb-1 block text-neutral-600">Amount received/paid (Rs)</span>
        <input
          required
          type="number"
          min={0.01}
          step={0.01}
          max={remainingInPaisa / 100}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="input"
        />
      </label>
      <label className="text-xs">
        <span className="mb-1 block text-neutral-600">Note (optional)</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} className="input" />
      </label>
      <button disabled={saving} className="btn-primary text-xs disabled:opacity-50">
        {saving ? "Settling…" : "Confirm settlement"}
      </button>
      <span className="text-xs text-neutral-400">
        Remaining: {formatNPR(remainingInPaisa)}
      </span>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Month / year rollup
// ---------------------------------------------------------------------------

function RollupView({
  rollup,
  granularity,
  anchorDate,
  onNavigate,
  onDrillDown,
}: {
  rollup: Rollup | null;
  granularity: "month" | "year";
  anchorDate: string;
  onNavigate: (delta: number) => void;
  onDrillDown: (key: string) => void;
}) {
  const dateSystem = useDateSystem();
  if (!rollup) return null;
  // Same approximation as formatMonthLabel: "year" here means the BS year
  // Jan 1st of the Gregorian anchor year falls in, since the rollup itself
  // is still grouped by Gregorian year on the API side.
  const heading =
    granularity === "month"
      ? formatMonthLabel(anchorDate, dateSystem)
      : dateSystem === "BS"
        ? formatBsYear(`${anchorDate.slice(0, 4)}-01-01`)
        : anchorDate.slice(0, 4);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button onClick={() => onNavigate(-1)} className="btn-secondary px-2 py-1 text-xs">
          ← Previous {granularity}
        </button>
        <p className="text-sm font-semibold text-neutral-900">{heading}</p>
        <button onClick={() => onNavigate(1)} className="btn-secondary px-2 py-1 text-xs">
          Next {granularity} →
        </button>
      </div>

      <TotalsStrip totals={rollup.totals} />

      <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="px-3 py-2">{granularity === "month" ? "Day" : "Month"}</th>
              <th className="px-3 py-2 text-right">Cash in</th>
              <th className="px-3 py-2 text-right">Cash out</th>
              <th className="px-3 py-2 text-right">Net</th>
              <th className="px-3 py-2 text-right">On credit</th>
            </tr>
          </thead>
          <tbody>
            {rollup.rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-neutral-400">
                  No entries in this {granularity}.
                </td>
              </tr>
            )}
            {rollup.rows.map((row) => (
              <tr
                key={row.key}
                onClick={() => onDrillDown(row.key)}
                className="cursor-pointer border-t border-neutral-100 hover:bg-neutral-50"
              >
                <td className="px-3 py-2 font-medium text-neutral-900">
                  {granularity === "month"
                    ? formatDayLabel(row.key, dateSystem)
                    : formatMonthLabel(`${row.key}-01`, dateSystem)}
                </td>
                <td className="px-3 py-2 text-right text-green-700">{formatNPR(row.creditInPaisa)}</td>
                <td className="px-3 py-2 text-right text-red-700">{formatNPR(row.debitInPaisa)}</td>
                <td
                  className={`px-3 py-2 text-right font-medium ${
                    row.netInPaisa >= 0 ? "text-green-700" : "text-red-700"
                  }`}
                >
                  {formatNPR(row.netInPaisa)}
                </td>
                <td className="px-3 py-2 text-right text-amber-700">
                  {row.outstandingCreditInPaisa + row.outstandingDebitInPaisa > 0
                    ? formatNPR(row.outstandingCreditInPaisa + row.outstandingDebitInPaisa)
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Due tracking
// ---------------------------------------------------------------------------

function DueTrackingView({
  slug,
  dues,
  onSettled,
}: {
  slug: string;
  dues: OutstandingDue[];
  onSettled: () => void;
}) {
  if (dues.length === 0) {
    return <p className="text-sm text-neutral-400">No outstanding dues right now.</p>;
  }

  return (
    <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white">
      <table className="w-full text-sm">
        <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
          <tr>
            <th className="px-3 py-2">Since</th>
            <th className="px-3 py-2">Direction</th>
            <th className="px-3 py-2">Counterparty</th>
            <th className="px-3 py-2">Description</th>
            <th className="px-3 py-2 text-right">Remaining</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {dues.map((due) => (
            <DueRow key={due.id} slug={slug} due={due} onSettled={onSettled} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DueRow({ slug, due, onSettled }: { slug: string; due: OutstandingDue; onSettled: () => void }) {
  const [showSettle, setShowSettle] = useState(false);
  const dateSystem = useDateSystem();
  return (
    <>
      <tr className="border-t border-neutral-100">
        <td className="px-3 py-2 text-neutral-500">{formatDate(`${due.entryDate}T00:00:00`, dateSystem)}</td>
        <td className="px-3 py-2">
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              due.direction === "credit" ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"
            }`}
          >
            {due.direction === "credit" ? "Owed to you" : "You owe"}
          </span>
        </td>
        <td className="px-3 py-2 text-neutral-700">{due.counterpartyName || "—"}</td>
        <td className="px-3 py-2 text-neutral-500">{due.description}</td>
        <td className="px-3 py-2 text-right font-medium text-amber-700">
          {formatNPR(due.remainingInPaisa)}
        </td>
        <td className="px-3 py-2 text-right">
          <button onClick={() => setShowSettle((v) => !v)} className="btn-secondary text-xs">
            {showSettle ? "Cancel" : "Settle"}
          </button>
        </td>
      </tr>
      {showSettle && (
        <tr className="border-t border-neutral-100 bg-amber-50/50">
          <td colSpan={6} className="px-3 py-2">
            <SettleForm
              slug={slug}
              entryId={due.id}
              remainingInPaisa={due.remainingInPaisa}
              onSettled={() => {
                setShowSettle(false);
                onSettled();
              }}
            />
          </td>
        </tr>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Manual entry form
// ---------------------------------------------------------------------------

function AddEntryForm({
  slug,
  defaultDate,
  onAdded,
}: {
  slug: string;
  defaultDate: string;
  onAdded: () => void;
}) {
  const [direction, setDirection] = useState<LedgerDirection>("credit");
  const [category, setCategory] = useState<LedgerCategory>("sales");
  const [amount, setAmount] = useState("");
  const [counterpartyName, setCounterpartyName] = useState("");
  const [description, setDescription] = useState("");
  const [entryDate, setEntryDate] = useState(defaultDate);
  const [markAsDue, setMarkAsDue] = useState(false);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dateSystem = useDateSystem();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/ledger`, {
        direction,
        category,
        amount: Number(amount),
        counterpartyName: counterpartyName || undefined,
        description,
        entryDate,
        markAsDue,
        note: note || undefined,
      });
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add this entry.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded-2xl border border-neutral-200 bg-white p-4">
      {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Direction</span>
          <select
            value={direction}
            onChange={(e) => setDirection(e.target.value as LedgerDirection)}
            className="input"
          >
            <option value="credit">{LEDGER_DIRECTION_LABELS.credit}</option>
            <option value="debit">{LEDGER_DIRECTION_LABELS.debit}</option>
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Category</span>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as LedgerCategory)}
            className="input"
          >
            {MANUAL_LEDGER_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {LEDGER_CATEGORY_LABELS[c]}
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
            step={0.01}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="input"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Date</span>
          <input
            type="date"
            value={entryDate}
            onChange={(e) => setEntryDate(e.target.value)}
            className="input"
          />
          {dateSystem === "BS" && (
            <span className="mt-1 block text-xs text-neutral-400">{formatBsHint(entryDate)}</span>
          )}
        </label>
        <label className="text-sm sm:col-span-2">
          <span className="mb-1 block text-neutral-600">Description</span>
          <input
            required
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="input"
            placeholder="e.g. Cash sale, corner-shop supplies"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Counterparty (optional)</span>
          <input
            value={counterpartyName}
            onChange={(e) => setCounterpartyName(e.target.value)}
            className="input"
            placeholder="Customer / supplier / person"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-600">Note (optional)</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} className="input" />
        </label>
      </div>
      <label className="mt-3 flex items-center gap-2 text-sm text-neutral-600">
        <input type="checkbox" checked={markAsDue} onChange={(e) => setMarkAsDue(e.target.checked)} />
        On credit — no cash has changed hands yet (tracks as an outstanding due)
      </label>
      <button disabled={saving} className="btn-primary mt-3">
        {saving ? "Adding…" : "Add entry"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Financial Reconciliation (Commercial Launch Phase A.8)
// ---------------------------------------------------------------------------
// Manual checklist, not automated bank matching — see
// src/lib/financial-reconciliation.ts's module doc comment for the full
// reasoning. A human checks their own bank/gateway statement outside this
// app, then marks the matching payment(s) reconciled here. Cash never
// appears — it's already reconciled via Cash Register / Daily Closing.

type ReconciliationStatusFilter = "unreconciled" | "reconciled" | "all";

type PaymentReconciliationRow = {
  id: string;
  orderId: string;
  orderNumber: string;
  branchId: string;
  amountInPaisa: number;
  method: PaymentMethod;
  note: string | null;
  createdAt: string;
  reconciledAt: string | null;
  reconciledByUserId: string | null;
};

type ReconciliationSummaryRow = {
  method: PaymentMethod;
  reconciledCount: number;
  reconciledTotalInPaisa: number;
  unreconciledCount: number;
  unreconciledTotalInPaisa: number;
};

function ReconciliationView({ slug }: { slug: string }) {
  const { branches, activeBranchId } = useActiveBranch();
  const dateSystem = useDateSystem();
  const [status, setStatus] = useState<ReconciliationStatusFilter>("unreconciled");
  const [method, setMethod] = useState<PaymentMethod | "">("");
  const [rows, setRows] = useState<PaymentReconciliationRow[]>([]);
  const [summary, setSummary] = useState<ReconciliationSummaryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const branchName = (branchId: string) => branches.find((b) => b.id === branchId)?.name ?? "—";

  async function load() {
    setLoading(true);
    try {
      const params = new URLSearchParams({ status });
      if (activeBranchId) params.set("branchId", activeBranchId);
      if (method) params.set("method", method);
      const [listRes, summaryRes] = await Promise.all([
        apiGet<{ payments: PaymentReconciliationRow[] }>(
          `${base(slug)}/reconciliation?${params}`,
        ),
        apiGet<{ summary: ReconciliationSummaryRow[] }>(
          `${base(slug)}/reconciliation/summary?${activeBranchId ? `branchId=${activeBranchId}` : ""}`,
        ),
      ]);
      setRows(listRes.payments);
      setSummary(summaryRes.summary);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load reconciliation data.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, status, method, activeBranchId]);

  async function toggle(row: PaymentReconciliationRow) {
    try {
      await apiPost(`${base(slug)}/reconciliation/${row.id}/${row.reconciledAt ? "unmark" : "mark"}`, {});
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update this payment.");
    }
  }

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <p className="text-sm text-neutral-500">
        Card, mobile wallet, and other non-cash payments — confirm each against your bank or
        gateway statement, then mark it reconciled. Cash is reconciled separately via Cash
        Register shift close / Daily Closing.
      </p>

      {summary.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-3">
          {summary.map((s) => (
            <div key={s.method} className="rounded-2xl border border-neutral-200 bg-white p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
                {PAYMENT_METHOD_LABELS[s.method]}
              </p>
              <p className="mt-1 text-sm text-amber-700">
                {formatNPR(s.unreconciledTotalInPaisa)} unreconciled
                <span className="text-neutral-400"> ({s.unreconciledCount})</span>
              </p>
              <p className="text-sm text-green-700">
                {formatNPR(s.reconciledTotalInPaisa)} reconciled
                <span className="text-neutral-400"> ({s.reconciledCount})</span>
              </p>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-full border border-neutral-200 bg-white p-1">
          {(["unreconciled", "reconciled", "all"] as ReconciliationStatusFilter[]).map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              className={`rounded-full px-3 py-1.5 text-xs font-medium capitalize transition ${
                status === s ? "bg-orange-600 text-white" : "text-neutral-600 hover:bg-neutral-50"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
        <select
          value={method}
          onChange={(e) => setMethod(e.target.value as PaymentMethod | "")}
          className="input w-auto text-xs"
        >
          <option value="">All methods</option>
          <option value="card">Card</option>
          <option value="mobile_wallet">Mobile wallet</option>
          <option value="other">Other</option>
        </select>
      </div>

      {loading ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-neutral-400">Nothing to show for this filter.</p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Order</th>
                {branches.length > 1 && <th className="px-3 py-2">Branch</th>}
                <th className="px-3 py-2">Method</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t border-neutral-100">
                  <td className="px-3 py-2 text-neutral-500">
                    {formatDate(row.createdAt, dateSystem, { withTime: true })}
                  </td>
                  <td className="px-3 py-2 text-neutral-700">{row.orderNumber}</td>
                  {branches.length > 1 && (
                    <td className="px-3 py-2 text-neutral-500">{branchName(row.branchId)}</td>
                  )}
                  <td className="px-3 py-2 text-neutral-500">{PAYMENT_METHOD_LABELS[row.method]}</td>
                  <td
                    className={`px-3 py-2 text-right font-medium ${
                      row.amountInPaisa < 0 ? "text-red-700" : "text-neutral-800"
                    }`}
                  >
                    {formatNPR(row.amountInPaisa)}
                    {row.amountInPaisa < 0 && <span className="ml-1 text-xs text-neutral-400">(refund)</span>}
                  </td>
                  <td className="px-3 py-2">
                    {row.reconciledAt ? (
                      <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">
                        Reconciled
                      </span>
                    ) : (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                        Unreconciled
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={() => toggle(row)} className="btn-secondary text-xs">
                      {row.reconciledAt ? "Unmark" : "Mark reconciled"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
