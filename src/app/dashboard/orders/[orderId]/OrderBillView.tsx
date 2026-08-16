"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { apiGet, apiPatch, apiPost, ApiError } from "@/lib/api-client";
import { openKotTicket } from "@/lib/kot-print-client";
import { formatNPR, rupeesToPaisa, paisaToRupees, basisPointsToPercent } from "@/lib/money";
import {
  ORDER_STATUS_LABELS,
  nextForwardStatus,
  canTransition,
  type OrderStatus,
} from "@/lib/order-status";
import {
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  PAYMENT_STATUS_LABELS,
  type PaymentMethod,
  type PaymentStatus,
} from "@/lib/payments";

type OrderItemAddon = { id: string; nameSnapshot: string; priceInPaisaSnapshot: number };
type OrderItem = {
  id: string;
  menuItemNameSnapshot: string;
  variantNameSnapshot: string | null;
  unitPriceInPaisa: number;
  quantity: number;
  lineTotalInPaisa: number;
  notes: string | null;
  addons: OrderItemAddon[];
};
type Payment = {
  id: string;
  amountInPaisa: number;
  method: PaymentMethod;
  receivedInPaisa: number | null;
  tipInPaisa: number;
  refundOfPaymentId: string | null;
  note: string | null;
  createdAt: string;
};
type Order = {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  source: string;
  kotSequence: number | null;
  customerName: string | null;
  customerPhone: string | null;
  notes: string | null;
  subtotalInPaisa: number;
  taxInPaisa: number;
  discountType: "percentage" | "flat" | null;
  discountValue: number | null;
  discountInPaisa: number;
  discountReason: string | null;
  serviceChargeBasisPoints: number;
  serviceChargeInPaisa: number;
  totalInPaisa: number;
  placedAt: string;
  table: { id: string; name: string } | null;
  items: OrderItem[];
  payments: Payment[];
};
type Billing = {
  totalInPaisa: number;
  netPaidInPaisa: number;
  remainingDueInPaisa: number;
  tipTotalInPaisa: number;
  paymentStatus: PaymentStatus;
};

function base(slug: string) {
  return `/api/restaurants/${slug}`;
}

const ADVANCE_LABELS: Partial<Record<OrderStatus, string>> = {
  confirmed: "Confirm",
  preparing: "Start preparing",
  ready: "Mark ready",
  served: "Mark served",
  completed: "Complete",
};

const PAYMENT_STATUS_STYLES: Record<PaymentStatus, string> = {
  unpaid: "bg-red-50 text-red-700",
  partially_paid: "bg-amber-50 text-amber-700",
  paid: "bg-green-50 text-green-700",
};

export function OrderBillView({
  slug,
  orderId,
  canEdit,
  canCancel,
  canRefund,
  canApplyDiscount,
}: {
  slug: string;
  orderId: string;
  canEdit: boolean;
  canCancel: boolean;
  canRefund: boolean;
  canApplyDiscount: boolean;
}) {
  const [order, setOrder] = useState<Order | null>(null);
  const [billing, setBilling] = useState<Billing | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const searchParams = useSearchParams();
  const paymentOutcome = searchParams.get("payment");

  async function load() {
    try {
      const res = await apiGet<{ order: Order; billing: Billing }>(
        `${base(slug)}/orders/${orderId}`,
      );
      setOrder(res.order);
      setBilling(res.billing);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load this order.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, orderId]);

  async function updateStatus(status: OrderStatus, reason?: string) {
    if (!order) return;
    const wasPending = order.status === "pending";
    setBusy(true);
    try {
      const res = await apiPatch<{ order: Order }>(`${base(slug)}/orders/${orderId}/status`, {
        status,
        reason,
      });
      setOrder((prev) => (prev ? { ...prev, ...res.order } : prev));
      // Same "cut the ticket the moment the kitchen accepts this order" as
      // OrdersBoard — see the status route's pending -> confirmed handling.
      if (wasPending && status === "confirmed") {
        openKotTicket(orderId);
      }
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not update order status.");
    } finally {
      setBusy(false);
    }
  }

  function handleCancel() {
    if (!order) return;
    const reason = window.prompt(`Cancel order #${order.orderNumber}? Add a reason (optional):`);
    if (reason === null) return;
    updateStatus("cancelled", reason || undefined);
  }

  if (loading) return <p className="text-sm text-neutral-500">Loading order…</p>;
  if (loadError || !order || !billing) {
    return (
      <div className="space-y-3">
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {loadError ?? "Order not found."}
        </p>
        <Link href="/dashboard/orders" className="text-sm text-orange-700">
          ← Back to orders
        </Link>
      </div>
    );
  }

  const forward = nextForwardStatus(order.status);
  const canCancelThis = canTransition(order.status, "cancelled");

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-4 flex items-center justify-between print:hidden">
        <Link href="/dashboard/orders" className="text-sm text-neutral-500 hover:text-neutral-800">
          ← Back to orders
        </Link>
        <div className="flex gap-2">
          {order.kotSequence !== null && (
            <button onClick={() => openKotTicket(orderId)} className="btn-secondary">
              Reprint KOT #{order.kotSequence}
            </button>
          )}
          <button onClick={() => window.print()} className="btn-secondary">
            Print bill
          </button>
        </div>
      </div>

      <div className="rounded-2xl border border-neutral-200 bg-white p-6 print:border-0 print:p-0 print:shadow-none">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-neutral-900">Order #{order.orderNumber}</h1>
            <p className="text-sm text-neutral-500">
              {order.table ? order.table.name : "Takeaway"}
              {order.customerName ? ` · ${order.customerName}` : ""}
              {order.customerPhone ? ` · ${order.customerPhone}` : ""}
            </p>
            <p className="text-xs text-neutral-400">
              Placed {new Date(order.placedAt).toLocaleString("en-NP")} · source: {order.source}
            </p>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <span className="rounded-full bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-700">
              {ORDER_STATUS_LABELS[order.status]}
            </span>
            <span
              className={`rounded-full px-2.5 py-1 text-xs font-medium ${PAYMENT_STATUS_STYLES[billing.paymentStatus]}`}
            >
              {PAYMENT_STATUS_LABELS[billing.paymentStatus]}
            </span>
          </div>
        </div>

        {order.notes && (
          <p className="mb-4 rounded-lg bg-neutral-50 px-3 py-2 text-xs italic text-neutral-500">
            {order.notes}
          </p>
        )}

        {paymentOutcome === "success" && (
          <p className="mb-4 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700 print:hidden">
            Payment received — thank you.
          </p>
        )}
        {paymentOutcome === "failed" && (
          <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 print:hidden">
            The gateway payment was not completed. No charge was recorded — you can try again or
            record a manual payment below.
          </p>
        )}

        {((forward && canEdit) || (canCancelThis && canCancel)) && (
          <div className="mb-4 flex flex-wrap gap-2 print:hidden">
            {forward && canEdit && (
              <button
                disabled={busy}
                onClick={() => updateStatus(forward)}
                className="rounded-full bg-orange-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
              >
                {ADVANCE_LABELS[forward] ?? `Move to ${ORDER_STATUS_LABELS[forward]}`}
              </button>
            )}
            {canCancelThis && canCancel && (
              <button
                disabled={busy}
                onClick={handleCancel}
                className="rounded-full border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-500 hover:text-red-600 disabled:opacity-50"
              >
                Cancel order
              </button>
            )}
          </div>
        )}

        <table className="mb-4 w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-200 text-left text-xs text-neutral-500">
              <th className="py-1.5 font-medium">Item</th>
              <th className="py-1.5 text-center font-medium">Qty</th>
              <th className="py-1.5 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {order.items.map((item) => (
              <tr key={item.id} className="border-b border-neutral-100">
                <td className="py-2">
                  <p className="font-medium text-neutral-900">
                    {item.menuItemNameSnapshot}
                    {item.variantNameSnapshot ? ` — ${item.variantNameSnapshot}` : ""}
                  </p>
                  {item.addons.length > 0 && (
                    <p className="text-xs text-neutral-500">
                      {item.addons.map((a) => a.nameSnapshot).join(", ")}
                    </p>
                  )}
                  {item.notes && <p className="text-xs italic text-neutral-400">{item.notes}</p>}
                </td>
                <td className="py-2 text-center text-neutral-600">{item.quantity}</td>
                <td className="py-2 text-right font-medium text-neutral-900">
                  {formatNPR(item.lineTotalInPaisa)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="ml-auto max-w-xs space-y-1 text-sm">
          <div className="flex justify-between text-neutral-500">
            <span>Subtotal</span>
            <span>{formatNPR(order.subtotalInPaisa)}</span>
          </div>
          {order.discountInPaisa > 0 && (
            <div className="flex justify-between text-red-700">
              <span>
                Discount
                {order.discountType === "percentage" && order.discountValue
                  ? ` (${(order.discountValue / 100).toFixed(2)}%)`
                  : ""}
                {order.discountReason ? ` — ${order.discountReason}` : ""}
              </span>
              <span>−{formatNPR(order.discountInPaisa)}</span>
            </div>
          )}
          {order.serviceChargeInPaisa > 0 && (
            <div className="flex justify-between text-neutral-500">
              <span>Service charge ({(order.serviceChargeBasisPoints / 100).toFixed(2)}%)</span>
              <span>{formatNPR(order.serviceChargeInPaisa)}</span>
            </div>
          )}
          <div className="flex justify-between text-neutral-500">
            <span>Tax</span>
            <span>{formatNPR(order.taxInPaisa)}</span>
          </div>
          <div className="flex justify-between border-t border-neutral-200 pt-1 font-semibold text-neutral-900">
            <span>Total</span>
            <span>{formatNPR(order.totalInPaisa)}</span>
          </div>
          <div className="flex justify-between text-neutral-500">
            <span>Paid</span>
            <span>{formatNPR(billing.netPaidInPaisa)}</span>
          </div>
          {billing.tipTotalInPaisa > 0 && (
            <div className="flex justify-between text-neutral-500">
              <span>Tips (not part of the bill)</span>
              <span>{formatNPR(billing.tipTotalInPaisa)}</span>
            </div>
          )}
          <div className="flex justify-between font-semibold text-neutral-900">
            <span>Remaining due</span>
            <span>{formatNPR(billing.remainingDueInPaisa)}</span>
          </div>
        </div>
      </div>

      {canApplyDiscount && order.status !== "cancelled" && (
        <div className="mt-4 print:hidden">
          <AdjustmentsPanel slug={slug} orderId={orderId} order={order} onSaved={load} />
        </div>
      )}

      <div className="mt-4 grid grid-cols-1 gap-4 print:hidden md:grid-cols-2">
        <div className="rounded-2xl border border-neutral-200 bg-white p-5">
          <p className="mb-3 text-sm font-semibold text-neutral-900">Payment history</p>
          {order.payments.length === 0 ? (
            <p className="text-sm text-neutral-400">No payments recorded yet.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {order.payments.map((p) => (
                <li key={p.id} className="flex items-center justify-between border-b border-neutral-100 pb-2">
                  <div>
                    <p className={p.amountInPaisa < 0 ? "font-medium text-red-600" : "font-medium text-neutral-900"}>
                      {p.amountInPaisa < 0 ? "Refund" : "Payment"} · {PAYMENT_METHOD_LABELS[p.method]}
                    </p>
                    <p className="text-xs text-neutral-400">
                      {new Date(p.createdAt).toLocaleString("en-NP")}
                      {p.note ? ` · ${p.note}` : ""}
                      {p.tipInPaisa > 0 ? ` · tip ${formatNPR(p.tipInPaisa)}` : ""}
                    </p>
                  </div>
                  <span className={p.amountInPaisa < 0 ? "font-semibold text-red-600" : "font-semibold text-neutral-900"}>
                    {formatNPR(p.amountInPaisa)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="space-y-4">
          {canEdit && billing.remainingDueInPaisa > 0 && (
            <GatewayPaymentButtons slug={slug} orderId={orderId} />
          )}
          {canEdit && billing.remainingDueInPaisa > 0 && (
            <RecordPaymentForm
              slug={slug}
              orderId={orderId}
              remainingDueInPaisa={billing.remainingDueInPaisa}
              onRecorded={load}
            />
          )}
          {canRefund && billing.netPaidInPaisa > 0 && (
            <RecordRefundForm
              slug={slug}
              orderId={orderId}
              netPaidInPaisa={billing.netPaidInPaisa}
              payments={order.payments.filter((p) => p.amountInPaisa > 0)}
              onRecorded={load}
            />
          )}
        </div>
      </div>
    </div>
  );
}

type GatewayInitiateResponse =
  | { gateway: "esewa"; formUrl: string; fields: Record<string, string> }
  | { gateway: "khalti"; paymentUrl: string };

/** Builds and auto-submits a hidden POST form — eSewa's flow expects a
 * browser form submission (not a fetch redirect) to its hosted page. */
function submitEsewaForm(formUrl: string, fields: Record<string, string>) {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = formUrl;
  for (const [name, value] of Object.entries(fields)) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}

function GatewayPaymentButtons({ slug, orderId }: { slug: string; orderId: string }) {
  const [pending, setPending] = useState<"esewa" | "khalti" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function start(gateway: "esewa" | "khalti") {
    setPending(gateway);
    setError(null);
    try {
      const res = await apiPost<GatewayInitiateResponse>(
        `${base(slug)}/orders/${orderId}/payments/gateway/${gateway}/initiate`,
        {},
      );
      if (res.gateway === "esewa") {
        submitEsewaForm(res.formUrl, res.fields);
      } else {
        window.location.href = res.paymentUrl;
      }
      // Intentionally leave `pending` set — the browser is about to
      // navigate away, so there's no "success" state to reset to.
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start the payment.");
      setPending(null);
    }
  }

  return (
    <div className="rounded-2xl border border-neutral-200 bg-white p-5">
      <p className="mb-3 text-sm font-semibold text-neutral-900">Pay with a wallet</p>
      <div className="flex gap-2">
        <button
          onClick={() => start("esewa")}
          disabled={pending !== null}
          className="btn-secondary flex-1 disabled:opacity-50"
        >
          {pending === "esewa" ? "Redirecting…" : "Pay via eSewa"}
        </button>
        <button
          onClick={() => start("khalti")}
          disabled={pending !== null}
          className="btn-secondary flex-1 disabled:opacity-50"
        >
          {pending === "khalti" ? "Redirecting…" : "Pay via Khalti"}
        </button>
      </div>
      {error && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
    </div>
  );
}

function RecordPaymentForm({
  slug,
  orderId,
  remainingDueInPaisa,
  onRecorded,
}: {
  slug: string;
  orderId: string;
  remainingDueInPaisa: number;
  onRecorded: () => void;
}) {
  const [amount, setAmount] = useState(() => (remainingDueInPaisa / 100).toFixed(2));
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [receivedAmount, setReceivedAmount] = useState("");
  const [tip, setTip] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amountInPaisa = rupeesToPaisa(Number(amount) || 0);
  const receivedInPaisa = receivedAmount ? rupeesToPaisa(Number(receivedAmount) || 0) : null;
  const changeDue =
    method === "cash" && receivedInPaisa !== null ? receivedInPaisa - amountInPaisa : null;

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/orders/${orderId}/payments`, {
        amount: Number(amount),
        method,
        receivedAmount:
          method === "cash" && receivedAmount ? Number(receivedAmount) : undefined,
        tip: tip ? Number(tip) : undefined,
        note: note.trim() || undefined,
      });
      setNote("");
      setReceivedAmount("");
      setTip("");
      onRecorded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not record payment.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="rounded-2xl border border-neutral-200 bg-white p-5">
      <p className="mb-3 text-sm font-semibold text-neutral-900">Record a payment</p>
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
        {changeDue !== null && changeDue > 0 && (
          <p className="text-xs text-neutral-500">Change due: {formatNPR(changeDue)}</p>
        )}
        <input
          className="input"
          type="number"
          min="0"
          step="0.01"
          value={tip}
          onChange={(e) => setTip(e.target.value)}
          placeholder="Tip (optional, Rs.)"
        />
        <input
          className="input"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note (optional)"
        />
        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
        <button
          onClick={handleSubmit}
          disabled={submitting || !(Number(amount) > 0)}
          className="btn-primary w-full"
        >
          {submitting ? "Recording…" : `Record ${formatNPR(rupeesToPaisa(Number(amount) || 0))}`}
        </button>
      </div>
    </div>
  );
}

function RecordRefundForm({
  slug,
  orderId,
  netPaidInPaisa,
  payments,
  onRecorded,
}: {
  slug: string;
  orderId: string;
  netPaidInPaisa: number;
  payments: Payment[];
  onRecorded: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [reason, setReason] = useState("");
  const [refundOfPaymentId, setRefundOfPaymentId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      await apiPost(`${base(slug)}/orders/${orderId}/refunds`, {
        amount: Number(amount),
        method,
        reason: reason.trim() || undefined,
        refundOfPaymentId: refundOfPaymentId || undefined,
      });
      setAmount("");
      setReason("");
      setRefundOfPaymentId("");
      onRecorded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not record refund.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="rounded-2xl border border-neutral-200 bg-white p-5">
      <p className="mb-3 text-sm font-semibold text-neutral-900">Issue a refund</p>
      <p className="mb-2 text-xs text-neutral-500">
        Up to {formatNPR(netPaidInPaisa)} paid so far can be refunded.
      </p>
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
        {payments.length > 0 && (
          <select
            className="input"
            value={refundOfPaymentId}
            onChange={(e) => setRefundOfPaymentId(e.target.value)}
          >
            <option value="">General refund (not tied to a specific payment)</option>
            {payments.map((p) => (
              <option key={p.id} value={p.id}>
                Refund against {PAYMENT_METHOD_LABELS[p.method]} payment of {formatNPR(p.amountInPaisa)} (
                {new Date(p.createdAt).toLocaleDateString("en-NP")})
              </option>
            ))}
          </select>
        )}
        <input
          className="input"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (optional)"
        />
        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
        <button
          onClick={handleSubmit}
          disabled={submitting || !(Number(amount) > 0)}
          className="btn-secondary w-full"
        >
          {submitting ? "Recording…" : `Refund ${formatNPR(rupeesToPaisa(Number(amount) || 0))}`}
        </button>
      </div>
    </div>
  );
}

/**
 * Phase 13 — sets an order's discount + service charge via the dedicated
 * PATCH .../adjustments route. Only rendered when canApplyDiscount is true
 * (order.status !== "cancelled" is checked by the caller too).
 *
 * Whole-state, not a partial patch, matching the route's own contract
 * (see order-adjustments/route.ts) — every Save submits the COMPLETE
 * current form state, so there's no ambiguity about what an omitted field
 * means. The form is seeded from the order's current values so opening it
 * shows what's already applied, not a blank slate.
 */
function AdjustmentsPanel({
  slug,
  orderId,
  order,
  onSaved,
}: {
  slug: string;
  orderId: string;
  order: Order;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [discountType, setDiscountType] = useState<"none" | "percentage" | "flat">(
    order.discountType ?? "none",
  );
  const [discountPercentInput, setDiscountPercentInput] = useState(
    order.discountType === "percentage" && order.discountValue
      ? String(basisPointsToPercent(order.discountValue))
      : "",
  );
  const [discountFlatInput, setDiscountFlatInput] = useState(
    order.discountType === "flat" && order.discountValue
      ? String(paisaToRupees(order.discountValue))
      : "",
  );
  const [discountReason, setDiscountReason] = useState(order.discountReason ?? "");
  const [serviceChargePercentInput, setServiceChargePercentInput] = useState(
    order.serviceChargeBasisPoints
      ? String(basisPointsToPercent(order.serviceChargeBasisPoints))
      : "",
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setSubmitting(true);
    setError(null);
    try {
      await apiPatch(`${base(slug)}/orders/${orderId}/adjustments`, {
        discountType: discountType === "none" ? undefined : discountType,
        discountPercent:
          discountType === "percentage" ? Number(discountPercentInput) || 0 : undefined,
        discountFlatAmount: discountType === "flat" ? Number(discountFlatInput) || 0 : undefined,
        discountReason: discountReason.trim() || undefined,
        serviceChargePercent: Number(serviceChargePercentInput) || 0,
      });
      setOpen(false);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the discount/service charge.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="btn-secondary">
        {order.discountInPaisa > 0 || order.serviceChargeInPaisa > 0
          ? "Edit discount / service charge"
          : "Add discount / service charge"}
      </button>
    );
  }

  return (
    <div className="rounded-2xl border border-neutral-200 bg-white p-5">
      <p className="mb-3 text-sm font-semibold text-neutral-900">Discount / service charge</p>
      <div className="space-y-2">
        <div className="flex gap-1.5">
          {(["none", "percentage", "flat"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setDiscountType(t)}
              className={`flex-1 rounded-lg border px-2 py-1.5 text-xs font-medium ${
                discountType === t
                  ? "border-orange-600 bg-orange-50 text-orange-700"
                  : "border-neutral-200 text-neutral-500"
              }`}
            >
              {t === "none" ? "No discount" : t === "percentage" ? "% off" : "Flat Rs. off"}
            </button>
          ))}
        </div>
        {discountType === "percentage" && (
          <input
            className="input"
            type="number"
            min="0"
            max="100"
            step="0.01"
            value={discountPercentInput}
            onChange={(e) => setDiscountPercentInput(e.target.value)}
            placeholder="Discount %"
          />
        )}
        {discountType === "flat" && (
          <input
            className="input"
            type="number"
            min="0"
            step="0.01"
            value={discountFlatInput}
            onChange={(e) => setDiscountFlatInput(e.target.value)}
            placeholder="Discount amount (Rs.)"
          />
        )}
        {discountType !== "none" && (
          <input
            className="input"
            value={discountReason}
            onChange={(e) => setDiscountReason(e.target.value)}
            placeholder="Reason (optional)"
          />
        )}
        <input
          className="input"
          type="number"
          min="0"
          max="100"
          step="0.01"
          value={serviceChargePercentInput}
          onChange={(e) => setServiceChargePercentInput(e.target.value)}
          placeholder="Service charge % (optional)"
        />
        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
        <div className="flex gap-2">
          <button onClick={handleSave} disabled={submitting} className="btn-primary flex-1">
            {submitting ? "Saving…" : "Save"}
          </button>
          <button
            onClick={() => setOpen(false)}
            disabled={submitting}
            className="btn-secondary flex-1"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
