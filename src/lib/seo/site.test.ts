import { describe, it, expect, afterEach, vi } from "vitest";
import { getSiteUrl, absoluteUrl } from "./site";

/**
 * Regression coverage for a real production build crash: a deployment set
 * APP_URL to a bare domain ("restrokendra.com") with no "https://" scheme.
 * getSiteUrl() returned that value unchanged, and `new URL(getSiteUrl())`
 * in the root layout's metadataBase threw "Invalid URL" during
 * `next build` — the 8 pre-existing APP_URL call sites elsewhere in the
 * app never noticed this because they only string-concatenate it, so this
 * was the first thing to actually parse it as a URL. getSiteUrl() now
 * always normalizes a scheme onto whatever APP_URL resolves to.
 */
describe("getSiteUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("adds https:// when APP_URL is a bare domain with no scheme (the actual bug)", () => {
    vi.stubEnv("APP_URL", "restrokendra.com");
    const url = getSiteUrl();
    expect(url).toBe("https://restrokendra.com");
    // The real failure mode: this must not throw.
    expect(() => new URL(url)).not.toThrow();
  });

  it("leaves an already-scheme-prefixed APP_URL unchanged", () => {
    vi.stubEnv("APP_URL", "https://restrokendra.com");
    expect(getSiteUrl()).toBe("https://restrokendra.com");
  });

  it("strips a trailing slash regardless of scheme handling", () => {
    vi.stubEnv("APP_URL", "restrokendra.com/");
    expect(getSiteUrl()).toBe("https://restrokendra.com");
  });

  it("falls back to the production domain when APP_URL is unset in production", () => {
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("NODE_ENV", "production");
    expect(getSiteUrl()).toBe("https://restrokendra.com");
  });

  it("keeps localhost as-is (http) in non-production even if APP_URL is unset", () => {
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("NODE_ENV", "test");
    expect(getSiteUrl()).toBe("http://localhost:3000");
  });

  it("still returns a parseable URL for a scheme-less APP_URL outside production too", () => {
    vi.stubEnv("APP_URL", "example.com");
    vi.stubEnv("NODE_ENV", "test");
    const url = getSiteUrl();
    expect(() => new URL(url)).not.toThrow();
    expect(url).toBe("https://example.com");
  });
});

describe("absoluteUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves a root-relative path against a scheme-less APP_URL without throwing", () => {
    vi.stubEnv("APP_URL", "restrokendra.com");
    expect(absoluteUrl("/restaurant-pos-nepal")).toBe("https://restrokendra.com/restaurant-pos-nepal");
  });

  it("passes an already-absolute URL through unchanged", () => {
    expect(absoluteUrl("https://example.com/x")).toBe("https://example.com/x");
  });
});
