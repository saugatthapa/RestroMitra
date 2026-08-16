/**
 * Phase 11c: Khalti's initiate/lookup calls are real network requests to
 * dev.khalti.com, which is blocked from this build sandbox (see
 * PHASE_11c_NOTES.md) — so every test here goes through the injectable
 * `fetchImpl` param instead of the real network, exercising the request
 * shape, header, and response-parsing logic without ever leaving the
 * process.
 */
import { describe, it, expect, vi } from "vitest";
import { initiateKhaltiPayment, lookupKhaltiPayment, KhaltiApiError } from "./khalti";
import type { KhaltiConfig } from "./config";

const testConfig: KhaltiConfig = {
  env: "test",
  secretKey: "test-secret-key",
  initiateUrl: "https://dev.khalti.com/api/v2/epayment/initiate/",
  lookupUrl: "https://dev.khalti.com/api/v2/epayment/lookup/",
};

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 400) {
  return { ok, status, json: async () => body } as Response;
}

describe("initiateKhaltiPayment", () => {
  it("sends paisa amounts directly (no unit conversion) with the Key auth header", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ pidx: "pidx-123", payment_url: "https://pay.khalti.com/x", expires_in: 1800 }),
    );

    const result = await initiateKhaltiPayment(
      {
        amountInPaisa: 15000,
        purchaseOrderId: "ref-abc",
        purchaseOrderName: "Order TEST-0001",
        returnUrl: "https://example.com/callback",
        websiteUrl: "https://example.com",
      },
      testConfig,
      fetchImpl,
    );

    expect(result.pidx).toBe("pidx-123");
    expect(result.payment_url).toBe("https://pay.khalti.com/x");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(testConfig.initiateUrl);
    expect(init.headers.Authorization).toBe("Key test-secret-key");
    const body = JSON.parse(init.body);
    expect(body.amount).toBe(15000); // paisa, unchanged
    expect(body.purchase_order_id).toBe("ref-abc");
  });

  it("throws KhaltiApiError when Khalti responds with a non-ok status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ detail: "Invalid key" }, false, 401));
    await expect(
      initiateKhaltiPayment(
        {
          amountInPaisa: 100,
          purchaseOrderId: "ref",
          purchaseOrderName: "Order",
          returnUrl: "https://example.com/callback",
          websiteUrl: "https://example.com",
        },
        testConfig,
        fetchImpl,
      ),
    ).rejects.toBeInstanceOf(KhaltiApiError);
  });

  it("throws KhaltiApiError when the response body is missing pidx/payment_url", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ unexpected: true }));
    await expect(
      initiateKhaltiPayment(
        {
          amountInPaisa: 100,
          purchaseOrderId: "ref",
          purchaseOrderName: "Order",
          returnUrl: "https://example.com/callback",
          websiteUrl: "https://example.com",
        },
        testConfig,
        fetchImpl,
      ),
    ).rejects.toBeInstanceOf(KhaltiApiError);
  });
});

describe("lookupKhaltiPayment", () => {
  it("returns the parsed lookup result for a completed payment", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        pidx: "pidx-123",
        total_amount: 15000,
        status: "Completed",
        transaction_id: "txn-999",
        fee: 0,
        refunded: false,
      }),
    );

    const result = await lookupKhaltiPayment("pidx-123", testConfig, fetchImpl);
    expect(result.status).toBe("Completed");
    expect(result.total_amount).toBe(15000);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(testConfig.lookupUrl);
    expect(JSON.parse(init.body)).toEqual({ pidx: "pidx-123" });
  });

  it("throws KhaltiApiError on a malformed response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ no_status_field: true }));
    await expect(lookupKhaltiPayment("pidx-123", testConfig, fetchImpl)).rejects.toBeInstanceOf(
      KhaltiApiError,
    );
  });
});
