"use client";

import { useEffect, useState, useCallback } from "react";
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
  type: "addition" | "drop" | "payout";
  amountInPaisa: number;
  reason: string | null;
  createdAt: string;
};

function base(slug: string) {
  return `/api/restaurants/${slug}`;
}

function formatRupees(paisa: number) {
  return `Rs ${(paisa / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
}

const MOVEMENT_LABEL: Record<CashMovement["type"], string> = {
  addition: "Cash added",
  drop: "Cash dropped",
  payout: "Cash payout",
};

export function RegisterBoard({ slug }: { slug: string }) {
  const [shift, setShift] = useState<RegisterShift | null | undefined>(undefined);
  const [liveExpected, setLiveExpected] = useState<number | null>(null);
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

  const refresh = useCallback(async () => {
    try {
      const res = await apiGet<{ shift: RegisterShift | null; liveExpectedCashInPaisa?: number }>(
        `${base(slug)}/register-shifts/current`,
      );
      setShift(res.shift);
      setLiveExpected(res.liveExpectedCashInPaisa ?? null);
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

  useEffect(() => {
    refresh();
  }, [refresh]);

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
      await refresh();
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
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not close the register.");
    } finally {
      setBusy(false);
    }
  }

  if (shift === undefined) {
    return <p className="text-sm text-ink-faint">Loading…</p>;
  }

  return (
    <div className="space-y-6">
      {error && (
        <p className="rounded-md bg-red-500/15 px-3 py-2 text-sm text-red-400">{error}</p>
      )}

      {!shift ? (
        <form onSubmit={handleOpen} className="max-w-md rounded-lg border border-hairline bg-surface-2 p-5">
          <h2 className="text-sm font-semibold text-ink">Open a register shift</h2>
          <p className="mt-1 text-xs text-ink-muted">
            You don&apos;t have an open shift right now. Count your starting cash and open one to begin.
          </p>
          <div className="mt-4 space-y-3">
            <label className="block text-sm">
              <span className="mb-1 block text-ink-secondary">Register name</span>
              <input
                value={registerName}
                onChange={(e) => setRegisterName(e.target.value)}
                className="w-full rounded-md border border-hairline-strong px-3 py-1.5 text-sm"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-ink-secondary">Opening cash (Rs)</span>
              <input
                type="number"
                step="0.01"
                min="0"
                value={openingCash}
                onChange={(e) => setOpeningCash(e.target.value)}
                required
                className="w-full rounded-md border border-hairline-strong px-3 py-1.5 text-sm"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-ink-secondary">Notes (optional)</span>
              <input
                value={openingNotes}
                onChange={(e) => setOpeningNotes(e.target.value)}
                className="w-full rounded-md border border-hairline-strong px-3 py-1.5 text-sm"
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
          <div className="rounded-lg border border-hairline bg-surface-2 p-5">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-ink">
                  {shift.registerName} — open since {new Date(shift.openedAt).toLocaleString()}
                </h2>
                <p className="mt-1 text-xs text-ink-muted">Opening cash: {formatRupees(shift.openingCashInPaisa)}</p>
              </div>
              <span className="rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-400">
                Open
              </span>
            </div>
            {liveExpected !== null && (
              <p className="mt-3 text-2xl font-semibold text-ink">
                {formatRupees(liveExpected)}
                <span className="ml-2 text-sm font-normal text-ink-muted">expected cash right now</span>
              </p>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <form onSubmit={handleMovement} className="rounded-lg border border-hairline bg-surface-2 p-5">
              <h3 className="text-sm font-semibold text-ink">Record a cash movement</h3>
              <div className="mt-3 space-y-3">
                <label className="block text-sm">
                  <span className="mb-1 block text-ink-secondary">Type</span>
                  <select
                    value={movementType}
                    onChange={(e) => setMovementType(e.target.value as CashMovement["type"])}
                    className="w-full rounded-md border border-hairline-strong px-3 py-1.5 text-sm"
                  >
                    <option value="addition">Addition (cash in)</option>
                    <option value="drop">Drop (to safe)</option>
                    <option value="payout">Payout (spent from till)</option>
                  </select>
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-ink-secondary">Amount (Rs)</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={movementAmount}
                    onChange={(e) => setMovementAmount(e.target.value)}
                    required
                    className="w-full rounded-md border border-hairline-strong px-3 py-1.5 text-sm"
                  />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-ink-secondary">Reason (optional)</span>
                  <input
                    value={movementReason}
                    onChange={(e) => setMovementReason(e.target.value)}
                    className="w-full rounded-md border border-hairline-strong px-3 py-1.5 text-sm"
                  />
                </label>
              </div>
              <button
                type="submit"
                disabled={busy}
                className="mt-4 rounded-md border border-hairline-strong px-4 py-1.5 text-sm font-medium text-ink-secondary hover:bg-surface-1 disabled:opacity-60"
              >
                Record
              </button>
            </form>

            <div className="rounded-lg border border-hairline bg-surface-2 p-5">
              <h3 className="text-sm font-semibold text-ink">This shift&apos;s movements</h3>
              {movements.length === 0 ? (
                <p className="mt-2 text-sm text-ink-faint">No cash movements recorded yet.</p>
              ) : (
                <ul className="mt-2 space-y-2 text-sm">
                  {movements.map((m) => (
                    <li key={m.id} className="flex items-center justify-between border-b border-hairline/60 pb-1">
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

          <div className="rounded-lg border border-hairline bg-surface-2 p-5">
            {!showCloseForm ? (
              <button
                type="button"
                onClick={() => setShowCloseForm(true)}
                className="rounded-md bg-surface-0 px-4 py-1.5 text-sm font-medium text-white hover:bg-surface-3"
              >
                Close shift
              </button>
            ) : (
              <form onSubmit={handleClose} className="max-w-md">
                <h3 className="text-sm font-semibold text-ink">Close this shift</h3>
                <p className="mt-1 text-xs text-ink-muted">
                  Count the physical cash in the drawer and enter it below. This locks the shift.
                </p>
                <div className="mt-3 space-y-3">
                  <label className="block text-sm">
                    <span className="mb-1 block text-ink-secondary">Actual cash counted (Rs)</span>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={actualCash}
                      onChange={(e) => setActualCash(e.target.value)}
                      required
                      className="w-full rounded-md border border-hairline-strong px-3 py-1.5 text-sm"
                    />
                  </label>
                  <label className="block text-sm">
                    <span className="mb-1 block text-ink-secondary">Closing notes (optional)</span>
                    <input
                      value={closingNotes}
                      onChange={(e) => setClosingNotes(e.target.value)}
                      className="w-full rounded-md border border-hairline-strong px-3 py-1.5 text-sm"
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
                    className="rounded-md border border-hairline-strong px-4 py-1.5 text-sm font-medium text-ink-secondary hover:bg-surface-1"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </div>
        </>
      )}

    </div>
  );
}
