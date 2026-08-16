import "server-only";

/**
 * Phase 11c — payment gateway configuration.
 *
 * eSewa ships with a working sandbox default: eSewa publishes a single
 * shared UAT product code/secret key pair in their own developer docs
 * (`EPAYTEST` / `8gBm/:&EnhH.1/q(`), so a fresh clone of this repo can
 * exercise the whole eSewa flow against their real sandbox with zero setup.
 * Khalti has no such shared secret — every merchant (even in test mode)
 * gets their own key from a free signup at test-admin.khalti.com — so
 * KHALTI_SECRET_KEY is a required env var with no fallback; calling
 * getKhaltiConfig() without it throws immediately rather than silently
 * building requests that will 401.
 *
 * Both configs default to "test" env unless *_ENV is explicitly set to
 * "production", so a misconfigured/missing env var fails toward the safe
 * (sandbox, no real money) side rather than the dangerous one.
 */

export type EsewaConfig = {
  env: "test" | "production";
  productCode: string;
  secretKey: string;
  formUrl: string;
  statusCheckUrl: string;
};

export type KhaltiConfig = {
  env: "test" | "production";
  secretKey: string;
  initiateUrl: string;
  lookupUrl: string;
};

function resolveEnv(raw: string | undefined): "test" | "production" {
  return raw === "production" ? "production" : "test";
}

export function getEsewaConfig(): EsewaConfig {
  const env = resolveEnv(process.env.ESEWA_ENV);
  const isProd = env === "production";

  // eSewa's publicly documented UAT test credentials — see
  // https://developer.esewa.com.np/pages/Epay#test-credentials. Safe to
  // ship as defaults in test mode since they're already public and only
  // work against eSewa's own sandbox — but they must NEVER silently apply
  // in production. This used to fall back to an empty string in
  // production when the env vars were unset, which would have let anyone
  // forge a validly-signed "payment complete" callback (an HMAC computed
  // with a known/empty key is just as easy for an attacker to compute as
  // for us) and get an order marked paid with no money ever collected.
  const productCode = process.env.ESEWA_PRODUCT_CODE || (isProd ? "" : "EPAYTEST");
  const secretKey = process.env.ESEWA_SECRET_KEY || (isProd ? "" : "8gBm/:&EnhH.1/q(");

  if (isProd && (!productCode || !secretKey)) {
    throw new Error(
      "ESEWA_PRODUCT_CODE and ESEWA_SECRET_KEY must both be set when ESEWA_ENV=production. " +
        "eSewa's public UAT credentials only work against their sandbox — get your live " +
        "merchant credentials from eSewa before enabling production mode.",
    );
  }

  return {
    env,
    productCode,
    secretKey,
    formUrl: isProd
      ? "https://epay.esewa.com.np/api/epay/main/v2/form"
      : "https://rc-epay.esewa.com.np/api/epay/main/v2/form",
    statusCheckUrl: isProd
      ? "https://epay.esewa.com.np/api/epay/transaction/status"
      : "https://rc.esewa.com.np/api/epay/transaction/status",
  };
}

export function getKhaltiConfig(): KhaltiConfig {
  const env = resolveEnv(process.env.KHALTI_ENV);
  const isProd = env === "production";
  const secretKey = process.env.KHALTI_SECRET_KEY;
  if (!secretKey) {
    throw new Error(
      "KHALTI_SECRET_KEY is not set. Khalti has no shared sandbox key — sign up " +
        "for a free test account at https://test-admin.khalti.com and set your " +
        "own test secret key before using Khalti payments.",
    );
  }
  return {
    env,
    secretKey,
    initiateUrl: isProd
      ? "https://khalti.com/api/v2/epayment/initiate/"
      : "https://dev.khalti.com/api/v2/epayment/initiate/",
    lookupUrl: isProd
      ? "https://khalti.com/api/v2/epayment/lookup/"
      : "https://dev.khalti.com/api/v2/epayment/lookup/",
  };
}
