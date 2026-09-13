"use client";

import { Fragment, useEffect, useState, useCallback } from "react";
import { apiGet, apiPost, ApiError } from "@/lib/api-client";

type RegisterShift = {
  id: string;
  branchId: string;
  registerName: string;
  status: "open" | "closed";
  openedByUserId: string;
  openedAt: string;
  openingCashInPaisa: number;
  openingNotes: string | null;
  closedAt: string | null;
  actualCashInPaisa: number | null;
  expectedCashInPaisa: number | null;
  varianceInPaisa: number | null;
  closingNotes: string | null;
};

type CashMovement = {
  id: string;
  type: "addition" | "drop" | "payout" | "refund";
  amountInPaisa: number;
  reason: string | null;
  createdAt: string;
};

type ShiftCorrection = {
  id: string;
  previousActualCashInPaisa: number;
  newActualCashInPaisa: number;
  previousVarianceInPaisa: number;
  newVarianceInPaisa: number;
  reason: string;
  createdAt: string;
};

// Mirrors CashRegisterBreakdown in src/lib/cash-register.ts — every field
// here is one term of that one formula, never a separately-computed number,
// so this can never drift from what the backend actually froze/will freeze.
type CashBreakdown = {
  openingCashInPaisa: number;
  cashSalesInPaisa: number;
  cashRefundsInPaisa: number;
  cashExpensesInPaisa: number;
  additionsInPaisa: number;
  dropsInPaisa: number;
  payoutsInPaisa: number;
  expectedCashInPaisa: number;
};

function base(slug: string) {
  return `/api/restaurants/${slug}`;
}

function formatRupees(paisa: number) {
  return `Rs ${(paisa / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
}

function formatSignedRupees(paisa: number) {
  const sign = paisa > 0 ? "+" : paisa < 0 ? "−" : "";
  return `${sign}${formatRupees(Math.abs(paisa))}`;
}

const MOVEMENT_LABEL: Record<CashMovement["type"], string> = {
  addition: "Cash added",
  drop: "Cash dropped",
  payout: "Cash payout",
  refund: "Cash refund",
};

/**
 * The line-item breakdown card — same shape whether it's the LIVE numbers
 * for the open shift or the (recomputed, but never re-frozen) numbers
 * behind a closed shift's snapshot. Keeping this as one shared component
 * is what guarantees the open and closed views can never show the terms in
 * a different order or with different labels.
 */
function BreakdownList({ breakdown }: { breakdown: CashBreakdown }) {
  const cashOutInPaisa = breakdown.dropsInPaisa + breakdown.payoutsInPaisa;
  const rows: { label: string; value: number; emphasize?: boolean }[] = [
    { label: "Opening cash", value: breakdown.openingCashInPaisa },
    { label: "Cash sales", value: breakdown.cashSalesInPaisa },
    { label: "Cash refunds", value: -breakdown.cashRefundsInPaisa },
    { label: "Cash expenses", value: -breakdown.cashExpensesInPaisa },
    { label: "Cash-in (manual)", value: breakdown.additionsInPaisa },
    { label: "Cash-out (manual)", value: -cashOutInPaisa },
  ];
  return (
    <dl className="mt-3 space-y-1.5 text-sm">
      {rows.map((row) => (
        <div key={row.label} className="flex items-center justify-between">
          <dt className="text-neutral-500">{row.label}</dt>
          <dd className="tabular-nums text-neutral-800">
            {row.value < 0 ? "−" : ""}
            {formatRupees(Math.abs(row.value))}
          </dd>
        </div>
      ))}
      <div className="flex items-center justify-between border-t border-neutral-200 pt-1.5 font-semibold text-neutral-900">
        <dt>Expected cash</dt>
        <dd className="tabular-nums">{formatRupees(breakdown.expectedCashInPaisa)}</dd>
      </div>
    </dl>
  );
}

export function RegisterBoard({ slug }: { slug: string }) {
  const [shift, setShift] = useState<RegisterShift | null | undefined>(undefined);
  const [breakdown, setBreakdown] = useState<CashBreakdown | null>(null);
  const [movements, setMovements] = useState<CashMovement[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [openingCash, setOpeningCash] = useState("");
  const [registerName, setRegisterName] = useState("Main Register");
  const [openingNotes, setOpeningNotes] = useState("");

  const [movementType, setMovementType] = useState<CashMovement["type"]>("addition");
  const [movementAmount, setMovementAmount] = useState("");
  const [movementReason, setMovementReason] = useState("");

  const [actualCash, setActualCash] = useState("");
  const [closingNotes, setClosingNotes] = useState("");
  const [showCloseForm, setShowCloseForm] = useState(false);

  // Register / shift history — a flat list of past shifts (any status,
  // this branch's own access scope enforced server-side same as everywhere
  // else), each expandable into its own breakdown + movements + corrections
  // via the same detail route the live view already uses.
  const [history, setHistory] = useState<RegisterShift[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [expandedShiftId, setExpandedShiftId] = useState<string | null>(null);
  const [expandedDetail, setExpandedDetail] = useState<{
    breakdown: CashBreakdown;
    movements: CashMovement[];
    corrections: ShiftCorrection[];
  } | null>(null);
  const [expandedLoading, setExpandedLoading] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await apiGet<{ shift: RegisterShift | null; liveBreakdown?: CashBreakdown }>(
        `${base(slug)}/register-shifts/current`,
      );
      setShift(res.shift);
      setBreakdown(res.liveBreakdown ?? null);
      if (res.shift) {
        const detail = await apiGet<{ movements: CashMovement[] }>(
          `${base(slug)}/register-shifts/${res.shift.id}`,
        );
        setMovements(detail.movements);
      } else {
        setMovements([]);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load register status.");
    }
  }, [slug]);

  const refreshHistory = useCallback(async () => {
    try {
      const res = await apiGet<{ shifts: RegisterShift[] }>(`${base(slug)}/register-shifts`);
      setHistory(res.shifts);
      setHistoryError(null);
    } catch (err) {
      setHistoryError(err instanceof ApiError ? err.message : "Could not load register history.");
    }
  }, [slug]);

  useEffect(() => {
    refresh();
    refreshHistory();
  }, [refresh, refreshHistory]);

  async function toggleExpanded(shiftId: string) {
    if (expandedShiftId === shiftId) {
      setExpandedShiftId(null);
      setExpandedDetail(null);
      return;
    }
    setExpandedShiftId(shiftId);
    setExpandedDetail(null);
    setExpandedLoading(true);
    try {
      const detail = await apiGet<{
        breakdown: CashBreakdown;
        movements: CashMovement[];
        corrections: ShiftCorrection[];
      }>(`${base(slug)}/register-shifts/${shiftId}`);
      setExpandedDetail(detail);
    } catch (err) {
      setHistoryError(err instanceof ApiError ? err.message : "Could not load this shift's detail.");
    } finally {
      setExpandedLoading(false);
    }
  }

  async function handleOpen(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const paisa = Math.round(parseFloat(openingCash || "0") * 100);
    if (!Number.isFinite(paisa) || paisa < 0) {
      setError("Enter a valid opening cash amount.");
      return;
    }
    setBusy(true);
    try {
      await apiPost(`${base(slug)}/register-shifts`, {
        registerName: registerName.trim() || "Main Register",
        openingCashInPaisa: paisa,
        openingNotes: openingNotes.trim() || undefined,
      });
      setOpeningCash("");
      setOpeningNotes("");
      await Promise.all([refresh(), refreshHistory()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not open the register.");
    } finally {
      setBusy(false);
    }
  }

  async function handleMovement(e: React.FormEvent) {
    e.preventDefault();
    if (!shift) return;
    setError(null);
    const paisa = Math.round(parseFloat(movementAmount || "0") * 100);
    if (!Number.isFinite(paisa) || paisa <= 0) {
      setError("Enter a valid amount.");
      return;
    }
    setBusy(true);
    try {
      await apiPost(`${base(slug)}/register-shifts/${shift.id}/cash-movements`, {
        type: movementType,
        amountInPaisa: paisa,
        reason: movementReason.trim() || undefined,
      });
      setMovementAmount("");
      setMovementReason("");
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not record the cash movement.");
    } finally {
      setBusy(false);
    }
  }

  async function handleClose(e: React.FormEvent) {
    e.preventDefault();
    if (!shift) return;
    const paisa = Math.round(parseFloat(actualCash || "0") * 100);
    if (!Number.isFinite(paisa) || paisa < 0) {
      setError("Enter the counted cash amount.");
      return;
    }
    if (!window.confirm("Close this register shift? This locks the shift's numbers.")) return;
    setError(null);
    setBusy(true);
    try {
      await apiPost(`${base(slug)}/register-shifts/${shift.id}/close`, {
        actualCashInPaisa: paisa,
        closingNotes: closingNotes.trim() || undefined,
      });
      setActualCash("");
      setClosingNotes("");
      setShowCloseForm(false);
      await Promise.all([refresh(), refreshHistory()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not close the register.");
    } finally {
      setBusy(false);
    }
  }

  if (shift === undefined) {
    return <p className="text-sm text-neutral-400">Loading…</p>;
  }

  const projectedActual = Math.round(parseFloat(actualCash || "0") * 100);
  const projectedDifference =
    breakdown && actualCash.trim() !== "" && Number.isFinite(projectedActual)
      ? projectedActual - breakdown.expectedCashInPaisa
      : null;

  return (
    <div className="space-y-6">
      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}

      {!shift ? (
        <form onSubmit={handleOpen} className="max-w-md rounded-lg border border-neutral-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-neutral-900">Open a register shift</h2>
          <p className="mt-1 text-xs text-neutral-500">
            You don&apos;t have an open shift right now. Count your starting cash and open one to begin.
          </p>
          <div className="mt-4 space-y-3">
            <label className="block text-sm">
              <span className="mb-1 block text-neutral-700">Register name</span>
              <input
                value={registerName}
                onChange={(e) => setRegisterName(e.target.value)}
                className="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-neutral-700">Opening cash (Rs)</span>
              <input
                type="number"
                step="0.01"
                min="0"
                value={openingCash}
                onChange={(e) => setOpeningCash(e.target.value)}
                required
                className="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-neutral-700">Notes (optional)</span>
              <input
                value={openingNotes}
                onChange={(e) => setOpeningNotes(e.target.value)}
                className="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
              />
            </label>
          </div>
          <button
            type="submit"
            disabled={busy}
            className="mt-4 rounded-md bg-orange-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-orange-700 disabled:opacity-60"
          >
            {busy ? "Opening…" : "Open register"}
          </button>
        </form>
      ) : (
        <>
          <div className="rounded-lg border border-neutral-200 bg-white p-5">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-neutral-900">
                  {shift.registerName} — open since {new Date(shift.openedAt).toLocaleString()}
                </h2>
                <p className="mt-1 text-xs text-neutral-500">
                  Cash sales and cash expenses update themselves automatically from POS — nothing there
                  needs re-entering by hand. Cash refunds, cash-in, and cash-out are recorded manually
                  below, at the moment the cash actually changes hands.
                </p>
              </div>
              <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
                Open
              </span>
            </div>
            {breakdown && <BreakdownList breakdown={breakdown} />}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <form onSubmit={handleMovement} className="rounded-lg border border-neutral-200 bg-white p-5">
              <h3 className="text-sm font-semibold text-neutral-900">Record a cash movement</h3>
              <p className="mt-1 text-xs text-neutral-500">
                Only for cash the system can&apos;t see on its own — topping up change, pulling cash to
                the safe, a quick till payout, or money handed back for a returned/cancelled order.
              </p>
              <div className="mt-3 space-y-3">
                <label className="block text-sm">
                  <span className="mb-1 block text-neutral-700">Type</span>
                  <select
                    value={movementType}
                    onChange={(e) => setMovementType(e.target.value as CashMovement["type"])}
                    className="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
                  >
                    <option value="addition">Addition (cash in)</option>
                    <option value="drop">Drop (to safe)</option>
                    <option value="payout">Payout (spent from till)</option>
                    <option value="refund">Refund (returned/cancelled order)</option>
                  </select>
                  {movementType === "refund" && (
                    <span className="mt-1 block text-xs text-amber-700">
                      Only for money handed back on a returned or cancelled order. NOT for ordinary
                      change — if a customer pays Rs 150 for a Rs 120 item, the Rs 30 change is already
                      handled automatically and needs no entry here.
                    </span>
                  )}
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-neutral-700">Amount (Rs)</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={movementAmount}
                    onChange={(e) => setMovementAmount(e.target.value)}
                    required
                    className="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
                  />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-neutral-700">Reason (optional)</span>
                  <input
                    value={movementReason}
                    onChange={(e) => setMovementReason(e.target.value)}
                    className="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
                  />
                </label>
              </div>
              <button
                type="submit"
                disabled={busy}
                className="mt-4 rounded-md border border-neutral-300 px-4 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-60"
              >
                Record
              </button>
            </form>

            <div className="rounded-lg border border-neutral-200 bg-white p-5">
              <h3 className="text-sm font-semibold text-neutral-900">This shift&apos;s manual movements</h3>
              {movements.length === 0 ? (
                <p className="mt-2 text-sm text-neutral-400">No cash movements recorded yet.</p>
              ) : (
                <ul className="mt-2 space-y-2 text-sm">
                  {movements.map((m) => (
                    <li key={m.id} className="flex items-center justify-between border-b border-neutral-100 pb-1">
                      <span>
                        {MOVEMENT_LABEL[m.type]}
                        {m.reason ? ` — ${m.reason}` : ""}
                      </span>
                      <span className="font-medium tabular-nums">{formatRupees(m.amountInPaisa)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className="rounded-lg border border-neutral-200 bg-white p-5">
            {!showCloseForm ? (
              <button
                type="button"
                onClick={() => setShowCloseForm(true)}
                className="rounded-md bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-neutral-800"
              >
                Close shift
              </button>
            ) : (
              <form onSubmit={handleClose} className="max-w-md">
                <h3 className="text-sm font-semibold text-neutral-900">Close this shift</h3>
                <p className="mt-1 text-xs text-neutral-500">
                  Count the physical cash in the drawer and enter it below. This locks the shift.
                </p>
                {breakdown && (
                  <p className="mt-2 text-sm text-neutral-700">
                    Expected cash right now:{" "}
                    <span className="font-semibold tabular-nums">{formatRupees(breakdown.expectedCashInPaisa)}</span>
                  </p>
                )}
                <div className="mt-3 space-y-3">
                  <label className="block text-sm">
                    <span className="mb-1 block text-neutral-700">Actual cash counted (Rs)</span>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={actualCash}
                      onChange={(e) => setActualCash(e.target.value)}
                      required
                      className="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
                    />
                  </label>
                  {projectedDifference !== null && (
                    <p
                      className={`text-sm font-medium ${
                        projectedDifference === 0
                          ? "text-emerald-700"
                          : projectedDifference > 0
                            ? "text-blue-700"
                            : "text-red-700"
                      }`}
                    >
                      Difference: {formatSignedRupees(projectedDifference)}
                    </p>
                  )}
                  <label className="block text-sm">
                    <span className="mb-1 block text-neutral-700">Closing notes (optional)</span>
                    <input
                      value={closingNotes}
                      onChange={(e) => setClosingNotes(e.target.value)}
                      className="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
                    />
                  </label>
                </div>
                <div className="mt-4 flex gap-2">
                  <button
                    type="submit"
                    disabled={busy}
                    className="rounded-md bg-orange-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-orange-700 disabled:opacity-60"
                  >
                    {busy ? "Closing…" : "Confirm close"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowCloseForm(false)}
                    className="rounded-md border border-neutral-300 px-4 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </div>
        </>
      )}

      <div className="rounded-lg border border-neutral-200 bg-white p-5">
        <h3 className="text-sm font-semibold text-neutral-900">Register / shift history</h3>
        {historyError && <p className="mt-2 text-sm text-red-600">{historyError}</p>}
        {history === null ? (
          <p className="mt-2 text-sm text-neutral-400">Loading…</p>
        ) : history.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-400">No register shifts yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-xs text-neutral-500">
                  <th className="py-1.5 pr-3 font-medium">Register</th>
                  <th className="py-1.5 pr-3 font-medium">Opened</th>
                  <th className="py-1.5 pr-3 font-medium">Closed</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Opening</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Expected</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Actual</th>
                  <th className="py-1.5 text-right font-medium">Difference</th>
                </tr>
              </thead>
              <tbody>
                {history.map((row) => (
                  <Fragment key={row.id}>
                    <tr
                      onClick={() => toggleExpanded(row.id)}
                      className="cursor-pointer border-b border-neutral-100 hover:bg-neutral-50"
                    >
                      <td className="py-2 pr-3">
                        {row.registerName}
                        {row.status === "open" && (
                          <span className="ml-1.5 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700">
                            Open
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-neutral-500">{new Date(row.openedAt).toLocaleString()}</td>
                      <td className="py-2 pr-3 text-neutral-500">
                        {row.closedAt ? new Date(row.closedAt).toLocaleString() : "—"}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">{formatRupees(row.openingCashInPaisa)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {row.expectedCashInPaisa !== null ? formatRupees(row.expectedCashInPaisa) : "—"}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {row.actualCashInPaisa !== null ? formatRupees(row.actualCashInPaisa) : "—"}
                      </td>
                      <td
                        className={`py-2 text-right font-medium tabular-nums ${
                          row.varianceInPaisa === null
                            ? "text-neutral-400"
                            : row.varianceInPaisa === 0
                              ? "text-emerald-700"
                              : row.varianceInPaisa > 0
                                ? "text-blue-700"
                                : "text-red-700"
                        }`}
                      >
                        {row.varianceInPaisa !== null ? formatSignedRupees(row.varianceInPaisa) : "—"}
                      </td>
                    </tr>
                    {expandedShiftId === row.id && (
                      <tr key={`${row.id}-detail`} className="border-b border-neutral-100 bg-neutral-50">
                        <td colSpan={7} className="p-4">
                          {expandedLoading ? (
                            <p className="text-sm text-neutral-400">Loading…</p>
                          ) : expandedDetail ? (
                            <div className="grid gap-4 sm:grid-cols-2">
                              <div>
                                <BreakdownList breakdown={expandedDetail.breakdown} />
                              </div>
                              <div className="space-y-3">
                                <div>
                                  <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                                    Manual movements
                                  </p>
                                  {expandedDetail.movements.length === 0 ? (
                                    <p className="mt-1 text-sm text-neutral-400">None recorded.</p>
                                  ) : (
                                    <ul className="mt-1 space-y-1 text-sm">
                                      {expandedDetail.movements.map((m) => (
                                        <li key={m.id} className="flex items-center justify-between">
                                          <span>
                                            {MOVEMENT_LABEL[m.type]}
                                            {m.reason ? ` — ${m.reason}` : ""}
                                          </span>
                                          <span className="tabular-nums">{formatRupees(m.amountInPaisa)}</span>
                                        </li>
                                      ))}
                                    </ul>
                                  )}
                                </div>
                                {expandedDetail.corrections.length > 0 && (
                                  <div>
                                    <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                                      Corrections
                                    </p>
                                    <ul className="mt-1 space-y-1 text-sm">
                                      {expandedDetail.corrections.map((c) => (
                                        <li key={c.id}>
                                          <span className="text-neutral-700">
                                            {formatRupees(c.previousActualCashInPaisa)} →{" "}
                                            {formatRupees(c.newActualCashInPaisa)}
                                          </span>
                                          <span className="ml-2 text-neutral-400">— {c.reason}</span>
                                        </li>
                                      ))}
                                    </ul>
                                  </div>
                                )}
                                {row.closingNotes && (
                                  <div>
                                    <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                                      Closing notes
                                    </p>
                                    <p className="mt-1 text-sm text-neutral-700">{row.closingNotes}</p>
                                  </div>
                                )}
                              </div>
                            </div>
                          ) : (
                            <p className="text-sm text-neutral-400">Could not load this shift&apos;s detail.</p>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
