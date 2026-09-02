"use client";

import { useEffect, useState, useCallback } from "react";
import { apiGet, apiPost, ApiError } from "@/lib/api-client";

type Snapshot = {
  businessDate: string;
  branchId: string;
  sales: {
    grossSalesInPaisa: number;
    discountInPaisa: number;
    serviceChargeInPaisa: number;
    tipsInPaisa: number;
    netSalesInPaisa: number;
    refundInPaisa: number;
    orderCount: number;
  };
  paymentBreakdown: { method: string; totalInPaisa: number }[];
  expenses: {
    operatingExpensesInPaisa: number;
    cashExpensesInPaisa: number;
    purchasesInPaisa: number;
    purchaseCount: number;
  };
  register: {
    shiftsClosedCount: number;
    openingCashInPaisa: number | null;
    expectedCashInPaisa: number | null;
    actualCashInPaisa: number | null;
    varianceInPaisa: number | null;
  };
  inventory: {
    purchasesInPaisa: number;
    wastageCostInPaisa: number;
    stockAdjustmentNetValueChangeInPaisa: number;
    stockAdjustmentMovementCount: number;
  };
  profit: {
    revenueInPaisa: number;
    cogsInPaisa: number;
    grossProfitInPaisa: number;
    operatingExpensesInPaisa: number;
    netProfitInPaisa: number;
  };
};

type DailyCloseRow = {
  id: string;
  businessDate: string;
  closedAt: string;
  revenueInPaisa: number;
  netProfitInPaisa: number;
  cashVarianceInPaisa: number | null;
  notes: string | null;
};

function base(slug: string) {
  return `/api/restaurants/${slug}`;
}

function formatRupees(paisa: number) {
  const sign = paisa < 0 ? "-" : "";
  return `${sign}Rs ${(Math.abs(paisa) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between py-1 text-sm">
      <span className={muted ? "text-neutral-400" : "text-neutral-600"}>{label}</span>
      <span className={`tabular-nums font-medium ${muted ? "text-neutral-400" : "text-neutral-900"}`}>{value}</span>
    </div>
  );
}

export function DailyClosingBoard({ slug }: { slug: string }) {
  const [date, setDate] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [alreadyClosed, setAlreadyClosed] = useState(false);
  const [history, setHistory] = useState<DailyCloseRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState("");

  const loadPreview = useCallback(
    async (forDate?: string) => {
      setError(null);
      try {
        const qs = forDate ? `?date=${forDate}` : "";
        const res = await apiGet<{ snapshot: Snapshot; alreadyClosed: boolean }>(
          `${base(slug)}/daily-closes/preview${qs}`,
        );
        setSnapshot(res.snapshot);
        setAlreadyClosed(res.alreadyClosed);
        setDate(res.snapshot.businessDate);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Could not load the daily closing preview.");
      }
    },
    [slug],
  );

  const loadHistory = useCallback(async () => {
    try {
      const res = await apiGet<{ dailyCloses: DailyCloseRow[] }>(`${base(slug)}/daily-closes`);
      setHistory(res.dailyCloses);
    } catch {
      // History is secondary — a failure here doesn't block the preview/close flow.
    }
  }, [slug]);

  useEffect(() => {
    loadPreview();
    loadHistory();
  }, [loadPreview, loadHistory]);

  async function handleClose() {
    if (!snapshot) return;
    if (
      !window.confirm(
        `Close ${snapshot.businessDate}? This freezes the day's numbers and locks late edits to that day's financial records.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/daily-closes`, { businessDate: snapshot.businessDate, notes: notes.trim() || undefined });
      setNotes("");
      await Promise.all([loadPreview(snapshot.businessDate), loadHistory()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not close the day.");
    } finally {
      setBusy(false);
    }
  }

  if (!snapshot) {
    return error ? (
      <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
    ) : (
      <p className="text-sm text-neutral-400">Loading…</p>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm">
          <span className="mr-2 text-neutral-600">Date</span>
          <input
            type="date"
            value={date}
            onChange={(e) => loadPreview(e.target.value)}
            className="rounded-md border border-neutral-300 px-2 py-1 text-sm"
          />
        </label>
        {alreadyClosed ? (
          <span className="rounded-full bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-600">
            Closed
          </span>
        ) : (
          <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700">
            Not yet closed
          </span>
        )}
      </div>

      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <section className="rounded-lg border border-neutral-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-neutral-900">Sales</h2>
          <Row label="Gross sales" value={formatRupees(snapshot.sales.grossSalesInPaisa)} />
          <Row label="Discounts" value={formatRupees(snapshot.sales.discountInPaisa)} />
          <Row label="Service charge" value={formatRupees(snapshot.sales.serviceChargeInPaisa)} />
          <Row label="Tips" value={formatRupees(snapshot.sales.tipsInPaisa)} />
          <Row label="Refunds" value={formatRupees(snapshot.sales.refundInPaisa)} />
          <Row label="Net sales" value={formatRupees(snapshot.sales.netSalesInPaisa)} />
          <Row label="Orders" value={String(snapshot.sales.orderCount)} muted />
        </section>

        <section className="rounded-lg border border-neutral-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-neutral-900">Payment methods</h2>
          {snapshot.paymentBreakdown.length === 0 ? (
            <p className="mt-2 text-sm text-neutral-400">No payments recorded.</p>
          ) : (
            snapshot.paymentBreakdown.map((p) => (
              <Row key={p.method} label={p.method} value={formatRupees(p.totalInPaisa)} />
            ))
          )}
        </section>

        <section className="rounded-lg border border-neutral-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-neutral-900">Expenses</h2>
          <Row label="Operating expenses" value={formatRupees(snapshot.expenses.operatingExpensesInPaisa)} />
          <Row label="Cash expenses" value={formatRupees(snapshot.expenses.cashExpensesInPaisa)} />
          <Row
            label="Purchases"
            value={`${formatRupees(snapshot.expenses.purchasesInPaisa)} (${snapshot.expenses.purchaseCount})`}
          />
        </section>

        <section className="rounded-lg border border-neutral-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-neutral-900">Register</h2>
          {snapshot.register.shiftsClosedCount === 0 ? (
            <p className="mt-2 text-sm text-neutral-400">No register shifts closed this day.</p>
          ) : (
            <>
              <Row label="Opening cash" value={formatRupees(snapshot.register.openingCashInPaisa!)} />
              <Row label="Expected cash" value={formatRupees(snapshot.register.expectedCashInPaisa!)} />
              <Row label="Actual cash" value={formatRupees(snapshot.register.actualCashInPaisa!)} />
              <Row
                label="Variance"
                value={formatRupees(snapshot.register.varianceInPaisa!)}
              />
            </>
          )}
        </section>

        <section className="rounded-lg border border-neutral-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-neutral-900">Inventory</h2>
          <Row label="Purchases" value={formatRupees(snapshot.inventory.purchasesInPaisa)} />
          <Row label="Wastage cost" value={formatRupees(snapshot.inventory.wastageCostInPaisa)} />
          <Row
            label="Stock adjustments"
            value={`${formatRupees(snapshot.inventory.stockAdjustmentNetValueChangeInPaisa)} (${snapshot.inventory.stockAdjustmentMovementCount})`}
          />
        </section>

        <section className="rounded-lg border border-neutral-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-neutral-900">Profit snapshot</h2>
          <Row label="Revenue" value={formatRupees(snapshot.profit.revenueInPaisa)} />
          <Row label="COGS" value={formatRupees(snapshot.profit.cogsInPaisa)} />
          <Row label="Gross profit" value={formatRupees(snapshot.profit.grossProfitInPaisa)} />
          <Row label="Operating expenses" value={formatRupees(snapshot.profit.operatingExpensesInPaisa)} />
          <Row label="Net profit" value={formatRupees(snapshot.profit.netProfitInPaisa)} />
        </section>
      </div>

      {!alreadyClosed && (
        <div className="rounded-lg border border-neutral-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-neutral-900">Close this day</h2>
          <p className="mt-1 text-xs text-neutral-500">
            Freezes the numbers above and locks late edits to this day&apos;s financial records — a manager
            override is required afterward.
          </p>
          <label className="mt-3 block max-w-md text-sm">
            <span className="mb-1 block text-neutral-700">Notes (optional)</span>
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
            />
          </label>
          <button
            type="button"
            onClick={handleClose}
            disabled={busy}
            className="mt-3 rounded-md bg-orange-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-orange-700 disabled:opacity-60"
          >
            {busy ? "Closing…" : `Close ${snapshot.businessDate}`}
          </button>
        </div>
      )}

      <div className="rounded-lg border border-neutral-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-neutral-900">Recently closed days</h2>
        {history.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-400">No days closed yet.</p>
        ) : (
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-neutral-400">
                <th className="pb-1 font-normal">Date</th>
                <th className="pb-1 font-normal">Revenue</th>
                <th className="pb-1 font-normal">Net profit</th>
                <th className="pb-1 font-normal">Cash variance</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id} className="border-t border-neutral-100">
                  <td className="py-1.5">{h.businessDate}</td>
                  <td className="py-1.5 tabular-nums">{formatRupees(h.revenueInPaisa)}</td>
                  <td className="py-1.5 tabular-nums">{formatRupees(h.netProfitInPaisa)}</td>
                  <td className="py-1.5 tabular-nums">
                    {h.cashVarianceInPaisa === null ? (
                      <span className="text-neutral-400">—</span>
                    ) : (
                      formatRupees(h.cashVarianceInPaisa)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
