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
});
