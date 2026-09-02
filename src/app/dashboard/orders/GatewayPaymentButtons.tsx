"use client";

import { useState } from "react";
import { apiPost, ApiError } from "@/lib/api-client";

function base(slug: string) {
  return `/api/restaurants/${slug}`;
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

/**
 * The real eSewa/Khalti checkout flow — clicking a button here starts an
 * actual gateway payment (POST to eSewa's hosted form, or a redirect to
 * Khalti's payment_url) for the order's current remaining due amount, and
 * the order gets marked paid automatically by the signed server-to-server
 * callback once the customer completes it (see the initiate/callback
 * routes). This is deliberately the SAME component used from both the
 * Orders board's quick payment modal and the order bill page — previously
 * only the bill page had it, so in practice staff never saw it and always
 * fell back to manually marking a payment as "Mobile wallet" with no real
 * verification that the money actually moved.
 */
export function GatewayPaymentButtons({ slug, orderId }: { slug: string; orderId: string }) {
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
    <div className="rounded-2xl border border-hairline bg-surface-2 p-5">
      <p className="mb-3 text-sm font-semibold text-ink">Pay with a wallet</p>
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
      {error && <p className="mt-2 rounded-lg bg-red-500/15 px-3 py-2 text-xs text-red-400">{error}</p>}
    </div>
  );
}
