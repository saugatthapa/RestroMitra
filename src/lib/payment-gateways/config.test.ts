import { describe, it, expect, afterEach } from "vitest";
import { getEsewaConfig, getKhaltiConfig } from "./config";

const ORIGINAL_ENV = { ...process.env };

describe("getEsewaConfig", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("falls back to eSewa's public UAT sandbox credentials in test mode", () => {
    delete process.env.ESEWA_ENV;
    delete process.env.ESEWA_PRODUCT_CODE;
    delete process.env.ESEWA_SECRET_KEY;
    const config = getEsewaConfig();
    expect(config.env).toBe("test");
    expect(config.productCode).toBe("EPAYTEST");
    expect(config.secretKey).toBe("8gBm/:&EnhH.1/q(");
    expect(config.formUrl).toContain("rc-epay.esewa.com.np");
  });

  it(
    "QA hardening pass: throws rather than silently using empty/known " +
      "credentials when ESEWA_ENV=production and the real credentials are unset",
    () => {
      process.env.ESEWA_ENV = "production";
      delete process.env.ESEWA_PRODUCT_CODE;
      delete process.env.ESEWA_SECRET_KEY;
      expect(() => getEsewaConfig()).toThrow(
        /ESEWA_PRODUCT_CODE and ESEWA_SECRET_KEY must both be set/,
      );
    },
  );

  it("throws in production when only one of the two credentials is set", () => {
    process.env.ESEWA_ENV = "production";
    process.env.ESEWA_PRODUCT_CODE = "REAL_CODE";
    delete process.env.ESEWA_SECRET_KEY;
    expect(() => getEsewaConfig()).toThrow(
      /ESEWA_PRODUCT_CODE and ESEWA_SECRET_KEY must both be set/,
    );
  });

  it("returns the real credentials and live URLs when production is fully configured", () => {
    process.env.ESEWA_ENV = "production";
    process.env.ESEWA_PRODUCT_CODE = "REAL_CODE";
    process.env.ESEWA_SECRET_KEY = "REAL_SECRET";
    const config = getEsewaConfig();
    expect(config.env).toBe("production");
    expect(config.productCode).toBe("REAL_CODE");
    expect(config.secretKey).toBe("REAL_SECRET");
    expect(config.formUrl).toBe("https://epay.esewa.com.np/api/epay/main/v2/form");
    expect(config.statusCheckUrl).toBe("https://epay.esewa.com.np/api/epay/transaction/status");
  });
});

describe("getKhaltiConfig", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("throws an actionable error when KHALTI_SECRET_KEY is unset", () => {
    delete process.env.KHALTI_SECRET_KEY;
    expect(() => getKhaltiConfig()).toThrow(/KHALTI_SECRET_KEY is not set/);
  });

  it("returns a test-mode config with dev URLs by default", () => {
    process.env.KHALTI_SECRET_KEY = "test-secret";
    delete process.env.KHALTI_ENV;
    const config = getKhaltiConfig();
    expect(config.env).toBe("test");
    expect(config.secretKey).toBe("test-secret");
    expect(config.initiateUrl).toContain("dev.khalti.com");
  });

  it("returns a production config with live URLs when KHALTI_ENV=production", () => {
    process.env.KHALTI_SECRET_KEY = "live-secret";
    process.env.KHALTI_ENV = "production";
    const config = getKhaltiConfig();
    expect(config.env).toBe("production");
    expect(config.initiateUrl).toBe("https://khalti.com/api/v2/epayment/initiate/");
    expect(config.lookupUrl).toBe("https://khalti.com/api/v2/epayment/lookup/");
  });
});
