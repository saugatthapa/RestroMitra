import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { paisaToRupees } from "@/lib/money";
import { getEsewaConfig, type EsewaConfig } from "./config";

/**
 * eSewa ePay v2 — form-POST redirect flow.
 *
 * The merchant (us) builds a signed HTML form and the customer's browser
 * POSTs it to eSewa's hosted payment page; eSewa redirects the browser back
 * to our success_url (with a base64-encoded `data` query param) or
 * failure_url. Everything here is pure local computation (HMAC-SHA256, no
 * network) — the only genuinely network-dependent eSewa call is the
 * optional server-to-server status check, kept separate in
 * checkEsewaStatus() specifically so it can take an injectable fetchImpl
 * for testing (real network to esewa.com.np is blocked from this build
 * sandbox — see PHASE_11c_NOTES.md).
 */

// eSewa signs exactly these three fields, in exactly this order, joined as
// `field=value` pairs separated by commas. This set is fixed by eSewa's own
// API contract (see signed_field_names below) — not configurable per call.
const SIGNED_FIELD_NAMES = ["total_amount", "transaction_uuid", "product_code"] as const;

function esewaAmountString(amountInPaisa: number): string {
  // eSewa wants a plain decimal rupee string (e.g. "150.00"), not paisa.
  return paisaToRupees(amountInPaisa).toFixed(2);
}

function signFields(fields: Record<string, string>, secretKey: string): string {
  const message = SIGNED_FIELD_NAMES.map((name) => `${name}=${fields[name]}`).join(",");
  return createHmac("sha256", secretKey).update(message).digest("base64");
}

export type EsewaFormFields = {
  amount: string;
  tax_amount: string;
  total_amount: string;
  transaction_uuid: string;
  product_code: string;
  product_service_charge: string;
  product_delivery_charge: string;
  success_url: string;
  failure_url: string;
  signed_field_names: string;
  signature: string;
};

/**
 * Builds the signed form fields eSewa expects. `transactionUuid` must be
 * OUR OWN generated reference (see paymentGatewayTransactions.gatewayReference)
 * — never anything derived from client input — since it's the sole key used
 * to look the transaction back up when the callback arrives.
 */
export function buildEsewaFormFields(
  params: {
    amountInPaisa: number;
    transactionUuid: string;
    successUrl: string;
    failureUrl: string;
  },
  config: EsewaConfig = getEsewaConfig(),
): { url: string; fields: EsewaFormFields } {
  const totalAmount = esewaAmountString(params.amountInPaisa);
  const fields: Omit<EsewaFormFields, "signature"> = {
    amount: totalAmount,
    tax_amount: "0.00",
    total_amount: totalAmount,
    transaction_uuid: params.transactionUuid,
    product_code: config.productCode,
    product_service_charge: "0.00",
    product_delivery_charge: "0.00",
    success_url: params.successUrl,
    failure_url: params.failureUrl,
    signed_field_names: SIGNED_FIELD_NAMES.join(","),
  };
  const signature = signFields(
    { total_amount: fields.total_amount, transaction_uuid: fields.transaction_uuid, product_code: fields.product_code },
    config.secretKey,
  );
  return { url: config.formUrl, fields: { ...fields, signature } };
}

export type EsewaCallbackPayload = {
  transaction_code: string;
  status: string;
  total_amount: string;
  transaction_uuid: string;
  product_code: string;
  signed_field_names: string;
  signature: string;
  [key: string]: unknown;
};

/**
 * Decodes and verifies eSewa's success_url `data` query param. Returns the
 * parsed payload only if (a) it's valid base64-JSON and (b) recomputing the
 * signature over the fields it names matches the signature it shipped —
 * i.e. it was genuinely signed by someone holding our secret key, not
 * forged/tampered with in transit. Returns null on any failure; callers
 * should treat null exactly like an explicit failure redirect.
 */
export function verifyEsewaCallback(
  dataParam: string,
  config: EsewaConfig = getEsewaConfig(),
): EsewaCallbackPayload | null {
  let payload: EsewaCallbackPayload;
  try {
    const json = Buffer.from(dataParam, "base64").toString("utf8");
    payload = JSON.parse(json);
  } catch {
    return null;
  }
  if (
    !payload ||
    typeof payload.signature !== "string" ||
    typeof payload.signed_field_names !== "string"
  ) {
    return null;
  }
  const signedFieldNames = payload.signed_field_names.split(",");
  // Only ever trust the fixed field set we know how to verify — if eSewa's
  // response claims to have signed something outside that set, refuse
  // rather than trying to sign fields we don't understand.
  if (signedFieldNames.some((name) => !(SIGNED_FIELD_NAMES as readonly string[]).includes(name))) {
    return null;
  }
  const message = signedFieldNames.map((name) => `${name}=${payload[name]}`).join(",");
  const expected = createHmac("sha256", config.secretKey).update(message).digest("base64");
  // Constant-time compare, not `!==` — this is a security-boundary check
  // (does the caller actually hold our secret key), and `!==` on strings
  // short-circuits at the first mismatched byte, which is the textbook
  // timing side-channel `timingSafeEqual` exists to close. Length must
  // match first since timingSafeEqual throws (rather than returning false)
  // on differing buffer lengths — a forged/truncated signature is the
  // common case this guards, not a real risk in itself.
  const expectedBuf = Buffer.from(expected);
  const signatureBuf = Buffer.from(payload.signature);
  if (expectedBuf.length !== signatureBuf.length || !timingSafeEqual(expectedBuf, signatureBuf)) {
    return null;
  }
  return payload;
}

export type EsewaStatusResult = {
  status: string;
  raw: unknown;
};

/**
 * Optional server-to-server status check (GET, query-string params) — a
 * defense-in-depth confirmation beyond trusting the browser-redirect
 * callback alone. Takes an injectable fetchImpl so it can be exercised in
 * unit tests without live network (real network to esewa.com.np is blocked
 * from this build sandbox).
 */
export async function checkEsewaStatus(
  params: { amountInPaisa: number; transactionUuid: string },
  config: EsewaConfig = getEsewaConfig(),
  fetchImpl: typeof fetch = fetch,
): Promise<EsewaStatusResult> {
  const url = new URL(config.statusCheckUrl);
  url.searchParams.set("product_code", config.productCode);
  url.searchParams.set("total_amount", esewaAmountString(params.amountInPaisa));
  url.searchParams.set("transaction_uuid", params.transactionUuid);
  const res = await fetchImpl(url.toString());
  const raw = await res.json().catch(() => null);
  const status = raw && typeof raw === "object" && "status" in raw ? String((raw as { status: unknown }).status) : "UNKNOWN";
  return { status, raw };
}
