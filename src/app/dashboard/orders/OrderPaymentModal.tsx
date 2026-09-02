"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPatch, apiPost, ApiError } from "@/lib/api-client";
import { formatNPR, rupeesToPaisa } from "@/lib/money";
import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS, type PaymentMethod } from "@/lib/payments";
import { ConfirmModal } from "@/components/ConfirmModal";
import { GatewayPaymentButtons } from "./GatewayPaymentButtons";

type Billing = { remainingDueInPaisa: number };

function base(slug: string) {
  return `/api/restaurants/${slug}`;
}

/**
 * The on-the-spot payment dialog for the Orders board — this is what
 * "Record payment" and an unpaid "Complete" click both open now, instead of
 * either doing nothing visible (the old silent debt-booking) or requiring a
 * click through to the order's own page just to reach a payment form. Every
 * option here (record, complete-without-paying, cancel) is a plainly
 * labeled button in the same dialog — nothing is a click away on another
 * screen.
 *
 * completeAfterPayment distinguishes the two entry points:
 *  - Opened from "Record payment" on any order: just records a payment,
 *    order status is untouched.
 *  - Opened from "Complete" on an order that isn't fully paid: recording a
 *    payment also completes the order right after (that's what the person
 *    was trying to do), and a second, equally visible button lets them
 *    complete without paying at all — booking it as a due/credit on
 *    purpose, matching how a real credit sale to a regular is handled.
 */
export function OrderPaymentModal({
  slug,
  orderId,
  orderNumber,
  completeAfterPayment,
  onClose,
  onDone,
}: {
  slug: string;
  orderId: string;
  orderNumber: string;
  completeAfterPayment: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [remainingDueInPaisa, setRemainingDueInPaisa] = useState(0);

  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [receivedAmount, setReceivedAmount] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // "Complete without payment" is already an explicit, clearly-labeled
  // button (not a hidden default) — this second step is a plain, on-page
  // confirmation rather than a browser window.confirm(), so a non-technical
  // user reads an unmistakable dialog instead of a dismissable OS popup.
  const [confirmNoPayment, setConfirmNoPayment] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiGet<{ billing: Billing }>(`${base(slug)}/orders/${orderId}`);
        if (cancelled) return;
        setRemainingDueInPaisa(res.billing.remainingDueInPaisa);
        setAmount((res.billing.remainingDueInPaisa / 100).toFixed(2));
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof ApiError ? err.message : "Could not load this order's balance.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, orderId]);

  const amountInPaisa = rupeesToPaisa(Number(amount) || 0);

  async function handleRecordPayment() {
    setSubmitting(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/orders/${orderId}/payments`, {
        amount: Number(amount),
        method,
        receivedAmount: method === "cash" && receivedAmount ? Number(receivedAmount) : undefined,
        note: note.trim() || undefined,
      });
      if (completeAfterPayment) {
        await apiPatch(`${base(slug)}/orders/${orderId}/status`, { status: "completed" });
      }
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not record the payment.");
      setSubmitting(false);
    }
  }

  async function handleCompleteWithoutPayment() {
    setConfirmNoPayment(false);
    setSubmitting(true);
    setError(null);
    try {
      await apiPatch(`${base(slug)}/orders/${orderId}/status`, { status: "completed" });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not complete the order.");
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-surface-2 p-5 shadow-xl">
        <div className="mb-3 flex items-start justify-between">
          <p className="text-base font-semibold text-ink">Order #{orderNumber}</p>
          <button onClick={onClose} disabled={submitting} className="text-ink-faint hover:text-ink-secondary">
            ✕
          </button>
        </div>

        {loading ? (
          <p className="text-sm text-ink-muted">Loading…</p>
        ) : loadError ? (
          <p className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-400">{loadError}</p>
        ) : (
          <>
            <p className="mb-4 rounded-lg bg-amber-500/15 px-3 py-2 text-sm font-semibold text-amber-300">
              {formatNPR(remainingDueInPaisa)} due
            </p>

            <div className="mb-4">
              <GatewayPaymentButtons slug={slug} orderId={orderId} />
              <p className="my-3 text-center text-xs text-ink-faint">or record it manually</p>
            </div>

            <div className="space-y-2">
              <div className="flex gap-2">
                <input
                  className="input"
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="Amount (Rs.)"
                />
                <select
                  className="input"
                  value={method}
                  onChange={(e) => setMethod(e.target.value as PaymentMethod)}
                >
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {PAYMENT_METHOD_LABELS[m]}
                    </option>
                  ))}
                </select>
              </div>
              {method === "cash" && (
                <input
                  className="input"
                  type="number"
                  min="0"
                  step="0.01"
                  value={receivedAmount}
                  onChange={(e) => setReceivedAmount(e.target.value)}
                  placeholder="Cash received (optional, for change)"
                />
              )}
              <input
                className="input"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Note (optional)"
              />
            </div>

            {error && (
              <p className="mt-3 rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-400">{error}</p>
            )}

            <button
              onClick={handleRecordPayment}
              disabled={submitting || !(Number(amount) > 0)}
              className="btn-primary mt-4 w-full"
            >
              {submitting
                ? "Recording…"
                : completeAfterPayment
                  ? `Record ${formatNPR(amountInPaisa)} & complete order`
                  : `Record ${formatNPR(amountInPaisa)} payment`}
            </button>

            {completeAfterPayment && (
              <button
                onClick={() => setConfirmNoPayment(true)}
                disabled={submitting}
                className="btn-secondary mt-2 w-full disabled:opacity-60"
              >
                Complete without payment (mark as credit)
              </button>
            )}

            <button
              onClick={onClose}
              disabled={submitting}
              className="mt-2 w-full text-center text-sm text-ink-muted hover:text-ink disabled:opacity-60"
            >
              Cancel
            </button>
          </>
        )}
      </div>

      {confirmNoPayment && (
        <ConfirmModal
          title={`Complete order #${orderNumber} without payment?`}
          message={`${formatNPR(remainingDueInPaisa)} will be booked as a due/credit in Account Books.`}
          confirmLabel="Complete without payment"
          busy={submitting}
          onCancel={() => setConfirmNoPayment(false)}
          onConfirm={handleCompleteWithoutPayment}
        />
      )}
    </div>
  );
}
