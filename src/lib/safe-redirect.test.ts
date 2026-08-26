import { describe, it, expect } from "vitest";
import { safeInternalRedirect } from "./safe-redirect";

describe("safeInternalRedirect", () => {
  it("allows a plain internal path", () => {
    expect(safeInternalRedirect("/dashboard")).toBe("/dashboard");
    expect(safeInternalRedirect("/dashboard/orders")).toBe("/dashboard/orders");
  });

  it("allows an internal path with query string / hash", () => {
    expect(safeInternalRedirect("/dashboard/orders?status=open")).toBe(
      "/dashboard/orders?status=open",
    );
    expect(safeInternalRedirect("/dashboard#section")).toBe("/dashboard#section");
  });

  it("falls back to /dashboard when the value is missing", () => {
    expect(safeInternalRedirect(null)).toBe("/dashboard");
    expect(safeInternalRedirect(undefined)).toBe("/dashboard");
    expect(safeInternalRedirect("")).toBe("/dashboard");
  });

  it("rejects an absolute off-site URL", () => {
    expect(safeInternalRedirect("https://evil.com")).toBe("/dashboard");
    expect(safeInternalRedirect("http://evil.com/phish")).toBe("/dashboard");
  });

  it("rejects a protocol-relative (scheme-relative) URL", () => {
    expect(safeInternalRedirect("//evil.com")).toBe("/dashboard");
    expect(safeInternalRedirect("//evil.com/path")).toBe("/dashboard");
  });

  it("rejects a backslash variant some browsers normalize to protocol-relative", () => {
    expect(safeInternalRedirect("/\\evil.com")).toBe("/dashboard");
    expect(safeInternalRedirect("\\\\evil.com")).toBe("/dashboard");
  });

  it("rejects a javascript: scheme smuggled in", () => {
    expect(safeInternalRedirect("javascript:alert(1)")).toBe("/dashboard");
  });

  it("rejects a value that does not start with a single slash", () => {
    expect(safeInternalRedirect("dashboard")).toBe("/dashboard");
    expect(safeInternalRedirect("evil.com")).toBe("/dashboard");
  });

  it("honors a custom fallback", () => {
    expect(safeInternalRedirect("https://evil.com", "/login")).toBe("/login");
    expect(safeInternalRedirect(null, "/login")).toBe("/login");
  });

  // QA hardening pass (branch-isolation/open-redirect audit) — a value
  // starting with a single "/" and containing no colon still passes the
  // slash/scheme checks even with an embedded tab/newline/CR, but browsers
  // (and Node's URL parser) strip those bytes per the WHATWG URL spec
  // before resolving the URL — collapsing e.g. "/\t/evil.com" into
  // "//evil.com", a genuine scheme-relative off-origin URL. Verified
  // end-to-end against Next's actual router behavior; regression test for
  // the fix that rejects any embedded ASCII control character outright.
  it("rejects a value with an embedded control character that a URL parser would strip into a protocol-relative URL", () => {
    expect(safeInternalRedirect("/\t/evil.com")).toBe("/dashboard");
    expect(safeInternalRedirect("/\n/evil.com")).toBe("/dashboard");
    expect(safeInternalRedirect("/\r/evil.com")).toBe("/dashboard");
    // Sanity check that the exact bypass previously worked: stripping the
    // control character really does collapse this into "//evil.com".
    expect(new URL("/\t/evil.com", "https://example.com").href).toBe("https://evil.com/");
  });
});
