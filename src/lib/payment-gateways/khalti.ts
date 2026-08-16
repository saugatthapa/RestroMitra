import "server-only";
import { getKhaltiConfig, type KhaltiConfig } from "./config";

/**
 * Khalti KPG v2 — REST initiate + lookup flow (as opposed to eSewa's
 * form-POST). initiateKhaltiPayment() calls Khalti to get a hosted
 * payment_url to redirect the customer to; lookupKhaltiPayment() is the
 * server-to-server call that authoritatively confirms a payment's status
 * (never trust the query-string params on Khalti's return redirect alone —
 * always look up by the pidx WE stored from the initiate response).
 *
 * Both take an injectable fetchImpl (default global fetch) specifically so
 * they can be unit tested with a mocked network call — real network to
 * khalti.com/dev.khalti.com is blocked from this build sandbox, so these
 * two functions could not be live-verified here; see PHASE_11c_NOTES.md.
 *
 * Khalti amounts are in paisa already — matches this app's internal money
 * convention directly, unlike eSewa which wants decimal rupees.
 */

export const KHALTI_COMPLETED_STATUS = "Completed";

export type KhaltiInitiateParams = {
  amountInPaisa: number;
  purchaseOrderId: string;
  purchaseOrderName: string;
  returnUrl: string;
  websiteUrl: string;
  customerInfo?: { name?: string; email?: string; phone?: string };
};

export type KhaltiInitiateResult = {
  pidx: string;
  payment_url: string;
  expires_at?: string;
  expires_in?: number;
};

export class KhaltiApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "KhaltiApiError";
  }
}

export async function initiateKhaltiPayment(
  params: KhaltiInitiateParams,
  config: KhaltiConfig = getKhaltiConfig(),
  fetchImpl: typeof fetch = fetch,
): Promise<KhaltiInitiateResult> {
  const res = await fetchImpl(config.initiateUrl, {
    method: "POST",
    headers: {
      Authorization: `Key ${config.secretKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      return_url: params.returnUrl,
      website_url: params.websiteUrl,
      amount: params.amountInPaisa,
      purchase_order_id: params.purchaseOrderId,
      purchase_order_name: params.purchaseOrderName,
      ...(params.customerInfo ? { customer_info: params.customerInfo } : {}),
    }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || typeof body.pidx !== "string" || typeof body.payment_url !== "string") {
    throw new KhaltiApiError("Khalti initiate request failed.", res.status, body);
  }
  return body as KhaltiInitiateResult;
}

export type KhaltiLookupResult = {
  pidx: string;
  total_amount: number;
  status: string;
  transaction_id: string | null;
  fee: number;
  refunded: boolean;
};

/**
 * Looks up a payment's authoritative status by the pidx WE stored from the
 * initiate call — deliberately never the pidx read from a callback's own
 * query string, since that value arrives over an unauthenticated browser
 * redirect and could in principle be substituted for a different (valid,
 * but unrelated) pidx by anyone who noticed the URL pattern.
 */
export async function lookupKhaltiPayment(
  pidx: string,
  config: KhaltiConfig = getKhaltiConfig(),
  fetchImpl: typeof fetch = fetch,
): Promise<KhaltiLookupResult> {
  const res = await fetchImpl(config.lookupUrl, {
    method: "POST",
    headers: {
      Authorization: `Key ${config.secretKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ pidx }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || typeof body.status !== "string") {
    throw new KhaltiApiError("Khalti lookup request failed.", res.status, body);
  }
  return body as KhaltiLookupResult;
}
