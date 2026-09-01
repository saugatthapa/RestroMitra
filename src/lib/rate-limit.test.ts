import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rateLimit, __setRateLimitStoreForTests, type RateLimitStore } from "./rate-limit";

describe("rateLimit (in-memory backend, default when Upstash isn't configured)", () => {
  beforeEach(() => {
    // Make sure no test left a fake distributed store installed.
    __setRateLimitStoreForTests(undefined);
  });

  it("allows requests up to the limit", async () => {
    const key = `test:${crypto.randomUUID()}`;
    for (let i = 0; i < 3; i++) {
      const result = await rateLimit(key, { limit: 3, windowMs: 60_000 });
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(3 - (i + 1));
    }
  });

  it("blocks once the limit is exceeded within the window", async () => {
    const key = `test:${crypto.randomUUID()}`;
    for (let i = 0; i < 3; i++) {
      await rateLimit(key, { limit: 3, windowMs: 60_000 });
    }
    const blocked = await rateLimit(key, { limit: 3, windowMs: 60_000 });
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
  });

  it("keeps blocking on subsequent calls within the same window", async () => {
    const key = `test:${crypto.randomUUID()}`;
    for (let i = 0; i < 2; i++) {
      await rateLimit(key, { limit: 2, windowMs: 60_000 });
    }
    const first = await rateLimit(key, { limit: 2, windowMs: 60_000 });
    const second = await rateLimit(key, { limit: 2, windowMs: 60_000 });
    expect(first.allowed).toBe(false);
    expect(second.allowed).toBe(false);
  });

  it("resets and allows again once the window has elapsed", async () => {
    vi.useFakeTimers();
    try {
      const key = `test:${crypto.randomUUID()}`;
      const first = await rateLimit(key, { limit: 1, windowMs: 1_000 });
      expect(first.allowed).toBe(true);

      const stillBlocked = await rateLimit(key, { limit: 1, windowMs: 1_000 });
      expect(stillBlocked.allowed).toBe(false);

      vi.advanceTimersByTime(1_001);

      const afterReset = await rateLimit(key, { limit: 1, windowMs: 1_000 });
      expect(afterReset.allowed).toBe(true);
      expect(afterReset.remaining).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tracks independent keys independently", async () => {
    const keyA = `test:a:${crypto.randomUUID()}`;
    const keyB = `test:b:${crypto.randomUUID()}`;
    for (let i = 0; i < 5; i++) {
      await rateLimit(keyA, { limit: 5, windowMs: 60_000 });
    }
    const blockedA = await rateLimit(keyA, { limit: 5, windowMs: 60_000 });
    const allowedB = await rateLimit(keyB, { limit: 5, windowMs: 60_000 });
    expect(blockedA.allowed).toBe(false);
    expect(allowedB.allowed).toBe(true);
  });
});

describe("rateLimit (distributed backend, Upstash-backed via injected fake store)", () => {
  afterEach(() => {
    __setRateLimitStoreForTests(undefined);
  });

  /** A tiny in-process fake standing in for a real Upstash Redis instance. */
  function makeFakeStore(): { store: RateLimitStore; counters: Map<string, number> } {
    const counters = new Map<string, number>();
    const store: RateLimitStore = {
      async increment(key, windowMs) {
        const count = (counters.get(key) ?? 0) + 1;
        counters.set(key, count);
        return { count, ttlMs: windowMs };
      },
    };
    return { store, counters };
  }

  it("delegates counting to the injected store instead of the in-memory map", async () => {
    const { store, counters } = makeFakeStore();
    __setRateLimitStoreForTests(store);

    const key = `dist:${crypto.randomUUID()}`;
    const result = await rateLimit(key, { limit: 5, windowMs: 60_000 });

    expect(result).toEqual({ allowed: true, remaining: 4, resetAt: expect.any(Number) });
    expect(counters.get(key)).toBe(1);
  });

  it("allows exactly up to the limit and blocks the request that exceeds it", async () => {
    const { store } = makeFakeStore();
    __setRateLimitStoreForTests(store);

    const key = `dist:${crypto.randomUUID()}`;
    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push(await rateLimit(key, { limit: 3, windowMs: 60_000 }));
    }

    expect(results[0]).toMatchObject({ allowed: true, remaining: 2 });
    expect(results[1]).toMatchObject({ allowed: true, remaining: 1 });
    expect(results[2]).toMatchObject({ allowed: true, remaining: 0 });
    // The 4th call (count = 4 > limit = 3) is the one that gets blocked —
    // proving the decision is driven by the atomic counter's return value,
    // not a separate (raceable) check performed beforehand.
    expect(results[3]).toMatchObject({ allowed: false, remaining: 0 });
  });

  it("calls the store's atomic increment exactly once per rateLimit() call (no separate check-then-act step)", async () => {
    const increment = vi.fn(async (_key: string, windowMs: number) => ({ count: 1, ttlMs: windowMs }));
    __setRateLimitStoreForTests({ increment });

    await rateLimit("dist:single-call", { limit: 10, windowMs: 30_000 });

    expect(increment).toHaveBeenCalledTimes(1);
    expect(increment).toHaveBeenCalledWith("dist:single-call", 30_000);
  });

  it("derives resetAt from the store-reported ttlMs", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      __setRateLimitStoreForTests({
        increment: async () => ({ count: 1, ttlMs: 12_345 }),
      });

      const result = await rateLimit("dist:ttl", { limit: 5, windowMs: 60_000 });
      expect(result.resetAt).toBe(now + 12_345);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("keeps independent counters per key even under the distributed backend", async () => {
    const { store } = makeFakeStore();
    __setRateLimitStoreForTests(store);

    const keyA = `dist:a:${crypto.randomUUID()}`;
    const keyB = `dist:b:${crypto.randomUUID()}`;
    await rateLimit(keyA, { limit: 2, windowMs: 60_000 });
    await rateLimit(keyA, { limit: 2, windowMs: 60_000 });
    const blockedA = await rateLimit(keyA, { limit: 2, windowMs: 60_000 });
    const allowedB = await rateLimit(keyB, { limit: 2, windowMs: 60_000 });

    expect(blockedA.allowed).toBe(false);
    expect(allowedB.allowed).toBe(true);
  });
});
