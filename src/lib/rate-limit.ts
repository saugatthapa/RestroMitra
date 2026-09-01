/**
 * Rate limiter for auth and abuse-prone endpoints (login, register, MFA,
 * QR ordering, payment gateways, admin impersonation, etc.).
 *
 * Two backends, selected once per process the first time `rateLimit()` runs:
 *
 * - In-memory (default): a `Map`-based fixed-window counter. Fine for a
 *   single Node.js process / single-instance deployment (the app's
 *   current, verified production target — see README "Deploying"). Every
 *   counter resets on process restart and is NOT shared across processes,
 *   so it silently multiplies every limit by the instance/worker count if
 *   this app ever runs behind a load balancer with more than one instance,
 *   or under `pm2 -i <n>` cluster mode.
 * - Upstash Redis (REST-based — no persistent TCP connection, so it works
 *   from serverless/edge runtimes): activated automatically when both
 *   `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are set.
 *   Counters live in Redis, so every process/instance/worker shares the
 *   same limit. Implemented as a fixed-window counter using a single
 *   pipelined INCR + PEXPIRE(NX) + PTTL request: INCR is Redis's own
 *   atomic increment (the actual admit/deny decision is based solely on
 *   its returned count), PEXPIRE...NX sets the window's expiry only on the
 *   increment that created the key (so a raced concurrent request can
 *   never re-extend an already-ticking window), and PTTL is used only to
 *   report an accurate `resetAt` — none of the three affects the count.
 *   Pipelining the three together also means no other client's command can
 *   be interleaved between them (Redis processes one connection's queued
 *   commands back-to-back), so there is no separate check-then-increment
 *   step to race.
 *
 * Both backends resolve to the exact same `{ allowed, remaining, resetAt }`
 * shape from the exact same `rateLimit(key, { limit, windowMs })` call.
 *
 * One real, deliberate behavior change from the original in-memory-only
 * version: `rateLimit()` is now `async` (returns a Promise). A REST-based
 * Redis client has no synchronous way to make a network call, and faking
 * synchronicity (e.g. blocking the event loop on the HTTP request) would
 * be a worse anti-pattern than the one this file exists to fix — especially
 * given Upstash was chosen specifically for serverless/edge compatibility,
 * where blocking calls aren't available at all. Every call site already
 * lives inside an `async` function, so each was updated to `await` this
 * call; no call site's logic, parameters, or handling of the resolved
 * `{ allowed, remaining, resetAt }` value changed.
 *
 * If only one of the two Upstash env vars is set, that is treated as
 * "not configured" and the in-memory backend is used — a silent fallback,
 * not a crash, so double-check both vars are present when expecting
 * distributed rate limiting to be active.
 */

type RateLimitResult = { allowed: boolean; remaining: number; resetAt: number };
type RateLimitOptions = { limit: number; windowMs: number };

// ---------------------------------------------------------------------------
// In-memory backend (default; also the fallback when Upstash isn't configured)
// ---------------------------------------------------------------------------

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

function rateLimitInMemory(key: string, { limit, windowMs }: RateLimitOptions): RateLimitResult {
  const now = Date.now();
  const existing = buckets.get(key);

  if (!existing || existing.resetAt < now) {
    const resetAt = now + windowMs;
    buckets.set(key, { count: 1, resetAt });
    return { allowed: true, remaining: limit - 1, resetAt };
  }

  if (existing.count >= limit) {
    return { allowed: false, remaining: 0, resetAt: existing.resetAt };
  }

  existing.count += 1;
  return {
    allowed: true,
    remaining: limit - existing.count,
    resetAt: existing.resetAt,
  };
}

// Occasionally sweep expired buckets so this map doesn't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt < now) buckets.delete(key);
  }
}, 60_000).unref?.();

// ---------------------------------------------------------------------------
// Distributed backend (Upstash Redis), activated when configured
// ---------------------------------------------------------------------------

/**
 * The minimal store interface the distributed path depends on. Kept as a
 * small interface — rather than depending on `@upstash/redis`'s own types
 * throughout this module — so tests can inject a fake store and exercise
 * the counting/expiry logic without any network access or the real
 * package's client.
 */
export interface RateLimitStore {
  /**
   * Atomically increments `key` and returns `{ count, ttlMs }`: `count` is
   * the new value after incrementing (1 on first use in a window), and
   * `ttlMs` is the key's remaining time-to-live in milliseconds (only
   * meaningful once an expiry has been set — implementations should
   * initialize it on the increment that creates the key).
   */
  increment(key: string, windowMs: number): Promise<{ count: number; ttlMs: number }>;
}

/** The slice of `@upstash/redis`'s `Redis` client this module depends on. */
interface UpstashLikeClient {
  pipeline(): {
    incr(key: string): unknown;
    pexpire(key: string, ms: number, nxOrXx?: "NX" | "XX"): unknown;
    pttl(key: string): unknown;
    exec<T extends unknown[]>(): Promise<T>;
  };
}

function createUpstashStore(client: UpstashLikeClient): RateLimitStore {
  return {
    async increment(key, windowMs) {
      const pipeline = client.pipeline();
      pipeline.incr(key);
      pipeline.pexpire(key, windowMs, "NX");
      pipeline.pttl(key);
      const [count, , ttl] = await pipeline.exec<[number, boolean | null, number]>();
      // A fresh key's PTTL can briefly read -1 (no expiry yet) if a client
      // implementation ever reorders pipeline effects; fall back to the
      // full window in that case so resetAt is never wildly wrong.
      const ttlMs = typeof ttl === "number" && ttl > 0 ? ttl : windowMs;
      return { count, ttlMs };
    },
  };
}

let storeOverride: RateLimitStore | null | undefined;
let cachedStore: RateLimitStore | null | undefined;

/**
 * Lazily constructs (and caches) the Upstash-backed store. Nothing here
 * touches the network, or even imports `@upstash/redis`, until this is
 * first called from `rateLimit()` — and env vars are checked before the
 * import — so simply importing this module never requires network access
 * or the env vars to exist. That keeps the sandbox / test / not-configured
 * path exactly as dependency-light as the original in-memory-only version.
 */
function getStore(): RateLimitStore | null {
  if (storeOverride !== undefined) return storeOverride;
  if (cachedStore !== undefined) return cachedStore;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    cachedStore = null;
    return cachedStore;
  }

  // Deferred require so the package is only ever touched once configured.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Redis } = require("@upstash/redis") as typeof import("@upstash/redis");
  cachedStore = createUpstashStore(new Redis({ url, token }));
  return cachedStore;
}

/**
 * Test-only hook: force a specific (fake/mocked) store, bypassing env-var
 * detection entirely, or pass `undefined` to reset back to normal
 * auto-detection (re-reading env vars on the next `rateLimit()` call).
 */
export function __setRateLimitStoreForTests(store: RateLimitStore | null | undefined): void {
  storeOverride = store;
  cachedStore = undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function rateLimit(key: string, options: RateLimitOptions): Promise<RateLimitResult> {
  const store = getStore();
  if (!store) return rateLimitInMemory(key, options);

  const { limit } = options;
  const { count, ttlMs } = await store.increment(key, options.windowMs);
  const resetAt = Date.now() + ttlMs;

  if (count > limit) {
    return { allowed: false, remaining: 0, resetAt };
  }
  return { allowed: true, remaining: Math.max(0, limit - count), resetAt };
}
