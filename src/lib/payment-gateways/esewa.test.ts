/**
 * Phase 11c: eSewa's signature scheme is pure local HMAC-SHA256 — no
 * network involved — so unlike Khalti, the whole round trip (build a
 * signed form → simulate eSewa echoing a signed callback → verify it) can
 * be fully exercised here without any network access. Uses the real
 * publicly documented eSewa UAT test secret key (getEsewaConfig()'s
 * default), the same one that ships as the app's own sandbox default.
 */
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { buildEsewaFormFields, verifyEsewaCallback } from "./esewa";
import type { EsewaConfig } from "./config";

const testConfig: EsewaConfig = {
  env: "test",
  productCode: "EPAYTEST",
  secretKey: "8gBm/:&EnhH.1/q(",
  formUrl: "https://rc-epay.esewa.com.np/api/epay/main/v2/form",
  statusCheckUrl: "https://rc.esewa.com.np/api/epay/transaction/status",
};

function signAsEsewa(fields: { total_amount: string; transaction_uuid: string; product_code: string }) {
  const message = `total_amount=${fields.total_amount},transaction_uuid=${fields.transaction_uuid},product_code=${fields.product_code}`;
  return createHmac("sha256", testConfig.secretKey).update(message).digest("base64");
}

describe("buildEsewaFormFields", () => {
  it("converts paisa to a decimal rupee string and produces a valid HMAC signature", () => {
    const { url, fields } = buildEsewaFormFields(
      {
        amountInPaisa: 15000,
        transactionUuid: "txn-abc-123",
        successUrl: "https://example.com/success",
        failureUrl: "https://example.com/failure",
      },
      testConfig,
    );

    expect(url).toBe(testConfig.formUrl);
    expect(fields.total_amount).toBe("150.00");
    expect(fields.amount).toBe("150.00");
    expect(fields.product_code).toBe("EPAYTEST");
    expect(fields.signed_field_names).toBe("total_amount,transaction_uuid,product_code");

    const expected = signAsEsewa({
      total_amount: fields.total_amount,
      transaction_uuid: fields.transaction_uuid,
      product_code: fields.product_code,
    });
    expect(fields.signature).toBe(expected);
  });

  it("rounds fractional paisa to the nearest 2-decimal rupee amount", () => {
    const { fields } = buildEsewaFormFields(
      {
        amountInPaisa: 99,
        transactionUuid: "txn-xyz",
        successUrl: "https://example.com/success",
        failureUrl: "https://example.com/failure",
      },
      testConfig,
    );
    expect(fields.total_amount).toBe("0.99");
  });
});

describe("verifyEsewaCallback", () => {
  function encodeCallback(payload: Record<string, unknown>): string {
    return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  }

  it("accepts a correctly signed payload matching eSewa's real callback shape", () => {
    const fields = { total_amount: "150.00", transaction_uuid: "txn-abc-123", product_code: "EPAYTEST" };
    const payload = {
      transaction_code: "0000AB",
      status: "COMPLETE",
      ...fields,
      signed_field_names: "total_amount,transaction_uuid,product_code",
      signature: signAsEsewa(fields),
    };

    const result = verifyEsewaCallback(encodeCallback(payload), testConfig);
    expect(result).not.toBeNull();
    expect(result?.status).toBe("COMPLETE");
    expect(result?.transaction_uuid).toBe("txn-abc-123");
  });

  it("rejects a payload whose signature was tampered with (amount changed after signing)", () => {
    const fields = { total_amount: "150.00", transaction_uuid: "txn-abc-123", product_code: "EPAYTEST" };
    const signature = signAsEsewa(fields);
    const tampered = {
      transaction_code: "0000AB",
      status: "COMPLETE",
      total_amount: "999.00", // attacker bumps the amount after the signature was computed
      transaction_uuid: fields.transaction_uuid,
      product_code: fields.product_code,
      signed_field_names: "total_amount,transaction_uuid,product_code",
      signature,
    };

    expect(verifyEsewaCallback(encodeCallback(tampered), testConfig)).toBeNull();
  });

  it("rejects a payload signed with a different secret key", () => {
    const fields = { total_amount: "150.00", transaction_uuid: "txn-abc-123", product_code: "EPAYTEST" };
    const message = `total_amount=${fields.total_amount},transaction_uuid=${fields.transaction_uuid},product_code=${fields.product_code}`;
    const wrongSignature = createHmac("sha256", "not-the-real-secret").update(message).digest("base64");
    const payload = {
      status: "COMPLETE",
      ...fields,
      signed_field_names: "total_amount,transaction_uuid,product_code",
      signature: wrongSignature,
    };

    expect(verifyEsewaCallback(encodeCallback(payload), testConfig)).toBeNull();
  });

  it("rejects malformed base64/JSON", () => {
    expect(verifyEsewaCallback("not-valid-base64-json!!!", testConfig)).toBeNull();
  });

  it("rejects a payload that claims to have signed fields outside the known set", () => {
    const payload = {
      status: "COMPLETE",
      total_amount: "150.00",
      transaction_uuid: "txn-abc-123",
      product_code: "EPAYTEST",
      signed_field_names: "total_amount,transaction_uuid,product_code,status",
      signature: "irrelevant",
    };
    expect(verifyEsewaCallback(encodeCallback(payload), testConfig)).toBeNull();
  });
});
