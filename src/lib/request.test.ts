/**
 * RC audit P1 regression test: proves getClientIp() picks the
 * TRUSTED_PROXY_COUNT-th entry from the RIGHT of X-Forwarded-For, not the
 * leftmost one — the leftmost entry is exactly the part of the header a
 * client can set directly, so trusting it verbatim let a request spoof its
 * way past every IP-keyed rate limit in this app by rotating the header on
 * each attempt.
 *
 * TRUSTED_PROXY_COUNT is read once at module load (a top-level `const`), so
 * these tests exercise the default (1) — the value that matches the actual
 * Hostinger single-instance deployment target — rather than trying to
 * re-import the module with a different env var per test.
 */
import { describe, it, expect } from "vitest";
import { getClientIp } from "./request";

function requestWithHeaders(headers: Record<string, string>): Request {
  return new Request("http://localhost/test", { headers });
}

describe("getClientIp", () => {
  it("returns the single entry when X-Forwarded-For has only one IP", () => {
    const req = requestWithHeaders({ "x-forwarded-for": "203.0.113.9" });
    expect(getClientIp(req)).toBe("203.0.113.9");
  });

  it("with the default trusted-proxy count of 1, returns the RIGHTMOST entry, not the leftmost client-controlled one", () => {
    // A client sends a forged leading entry; the real trusted proxy in
    // front of this app appends the actual observed remote address as the
    // last entry. Trusting the leftmost value (the old behavior) would
    // return the attacker-controlled "9.9.9.9" here instead.
    const req = requestWithHeaders({ "x-forwarded-for": "9.9.9.9, 203.0.113.9" });
    expect(getClientIp(req)).toBe("203.0.113.9");
  });

  it("still returns the rightmost entry even with several forged leading entries", () => {
    const req = requestWithHeaders({ "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3, 203.0.113.9" });
    expect(getClientIp(req)).toBe("203.0.113.9");
  });

  it("trims whitespace around each comma-separated entry", () => {
    const req = requestWithHeaders({ "x-forwarded-for": "9.9.9.9 ,  203.0.113.9 " });
    expect(getClientIp(req)).toBe("203.0.113.9");
  });

  it("falls back to X-Real-IP when X-Forwarded-For is absent", () => {
    const req = requestWithHeaders({ "x-real-ip": "198.51.100.7" });
    expect(getClientIp(req)).toBe("198.51.100.7");
  });

  it("prefers X-Forwarded-For over X-Real-IP when both are present", () => {
    const req = requestWithHeaders({ "x-forwarded-for": "203.0.113.9", "x-real-ip": "198.51.100.7" });
    expect(getClientIp(req)).toBe("203.0.113.9");
  });

  it("returns null when neither header is present", () => {
    const req = requestWithHeaders({});
    expect(getClientIp(req)).toBeNull();
  });

  it("returns null for an empty X-Forwarded-For value", () => {
    const req = requestWithHeaders({ "x-forwarded-for": "" });
    expect(getClientIp(req)).toBeNull();
  });
});
