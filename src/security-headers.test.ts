/**
 * Phase 2 (P1) — locks in the production security headers configured in
 * next.config.ts. This is a plain unit test (no server, no DB) so it runs
 * everywhere, unlike the manual curl/Playwright verification this config
 * was actually checked against (see P1_PHASE_REPORT.md) — its job is to
 * catch an accidental regression (someone removing the eSewa form-action
 * allowance and silently breaking real payments, or loosening frame-
 * ancestors/object-src without realizing it), not to prove the headers
 * work end-to-end in a browser.
 */
import { describe, it, expect } from "vitest";
import nextConfig from "../next.config";

describe("next.config.ts security headers", () => {
  it("applies one headers() rule to every route", async () => {
    const rules = await nextConfig.headers!();
    expect(rules).toHaveLength(1);
    expect(rules[0].source).toBe("/(.*)");
  });

  async function getHeader(name: string): Promise<string | undefined> {
    const rules = await nextConfig.headers!();
    return rules[0].headers.find((h) => h.key === name)?.value;
  }

  it("sets a Content-Security-Policy with the expected restrictive baseline", async () => {
    const csp = await getHeader("Content-Security-Policy");
    expect(csp).toBeDefined();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("upgrade-insecure-requests");
  });

  it("allow-lists eSewa's hosted checkout form in form-action — GatewayPaymentButtons.tsx does a real cross-origin form POST there", async () => {
    const csp = await getHeader("Content-Security-Policy");
    expect(csp).toContain("form-action");
    expect(csp).toContain("https://epay.esewa.com.np");
    expect(csp).toContain("https://rc-epay.esewa.com.np");
  });

  it("sets X-Frame-Options: DENY as a frame-ancestors backstop", async () => {
    expect(await getHeader("X-Frame-Options")).toBe("DENY");
  });

  it("sets X-Content-Type-Options: nosniff", async () => {
    expect(await getHeader("X-Content-Type-Options")).toBe("nosniff");
  });

  it("sets a Strict-Transport-Security header WITHOUT preload (a deliberate choice, not an omission)", async () => {
    const hsts = await getHeader("Strict-Transport-Security");
    expect(hsts).toBeDefined();
    expect(hsts).toContain("max-age=");
    expect(hsts).not.toContain("preload");
  });

  it("sets a Referrer-Policy", async () => {
    expect(await getHeader("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  it("disables unused browser features via Permissions-Policy (camera/mic/geolocation never used in this app)", async () => {
    const pp = await getHeader("Permissions-Policy");
    expect(pp).toContain("camera=()");
    expect(pp).toContain("microphone=()");
    expect(pp).toContain("geolocation=()");
  });
});
