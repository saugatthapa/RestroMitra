import "server-only";
import { EventEmitter } from "node:events";
import { and, asc, desc, eq, gt, lt } from "drizzle-orm";
import type { Database, Transaction } from "@/db";
import { db } from "@/db";
import { realtimeEvents } from "@/db/schema";

/**
 * Real-time event bus, backed by the database rather than PURELY an
 * in-memory pub/sub.
 *
 * Why the DB stays the source of truth: this app was originally built
 * against serverless deployment targets (Netlify Functions / Vercel) — see
 * the schema.ts comment above `realtimeEvents` for the full reasoning, and
 * rate-limit.ts for the same caveat documented elsewhere in this codebase.
 * A publish from one invocation and an open SSE connection on another can't
 * share in-memory state on a serverless host, so routing every event
 * through a table both can see is what makes this correct there — and it
 * stays correct even now that the actual deployment target (Hostinger
 * Node.js hosting, `npm start`) is one persistent long-running process,
 * or if this ever scales out to more than one instance behind a load
 * balancer in the future.
 *
 * Phase 25 — what changed: this app's real deployment is that one
 * persistent process, not serverless, so `publishEvent` and every open SSE
 * connection for the same restaurant now usually DO share memory. The
 * local `wake`/`waitForWake` pair below is a same-process shortcut layered
 * on top of the DB polling loop — publish also emits a local signal, and a
 * waiting connection wakes immediately instead of sitting out the rest of
 * its poll interval, then re-reads from the DB exactly as it always did.
 * The DB read stays authoritative (correctness, ordering, tenant/branch
 * scoping, reconnect catch-up all still flow through it unchanged) — this
 * only shortens the WAIT before that read happens. If a publish and a
 * connection ever end up on different processes (e.g. a future multi-
 * instance deploy), the emit simply reaches nobody and the connection falls
 * back to its normal ~1s poll cadence, exactly as before this existed —
 * never a correctness risk, only ever a latency win when it applies.
 */

// Deliberately module-level/per-process (see comment above). `setMaxListeners(0)`
// removes the default-10 warning threshold — one listener per currently-open
// SSE connection per restaurant is the expected shape, not a leak.
const localBus = new EventEmitter().setMaxListeners(0);

function wakeRestaurant(restaurantId: string): void {
  localBus.emit(restaurantId);
}

/** Resolves the instant `wakeRestaurant(restaurantId)` fires, or after
 *  `timeoutMs` regardless — so this always stands in for the old
 *  unconditional `setTimeout(resolve, pollIntervalMs)` wait with the exact
 *  same worst-case latency, just with a same-process fast path. */
function waitForWake(restaurantId: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      localBus.off(restaurantId, onWake);
      resolve();
    }, timeoutMs);
    function onWake() {
      clearTimeout(timer);
      resolve();
    }
    localBus.once(restaurantId, onWake);
  });
}

export type RealtimeEventType =
  | "order.created"
  | "order.status_changed"
  | "service_call.created"
  | "service_call.acknowledged"
  | "service_call.resolved";

type PublishParams = {
  restaurantId: string;
  /** Null = restaurant-wide (every connected staff member sees it). */
  branchId?: string | null;
  type: RealtimeEventType;
  payload: Record<string, unknown>;
};

/**
 * The single insert point every order/service-call route calls after its
 * own write commits. Accepts either a bare `db` or an in-flight `tx` so
 * callers that already wrap their write in a transaction (the common case —
 * order status changes, service call creation) can publish as part of the
 * same atomic commit, and the event is guaranteed to exist if and only if
 * the write it describes actually happened.
 */
export async function publishEvent(
  handle: Database | Transaction,
  params: PublishParams,
): Promise<void> {
  await handle.insert(realtimeEvents).values({
    restaurantId: params.restaurantId,
    branchId: params.branchId ?? null,
    type: params.type,
    payload: params.payload,
  });

  // Same-process fast path — see this file's header comment. Safe to fire
  // right after the insert above when `handle` is the bare `db` (a plain
  // statement auto-commits immediately in Postgres, so the row is already
  // visible to any connection by the time a woken SSE loop re-reads). A
  // caller that passed an in-flight `tx` here (order status changes,
  // service calls) can wake a connection slightly before ITS OWN outer
  // transaction commits — not a correctness issue, since the woken
  // connection just finds nothing new yet and falls back to the normal
  // poll cadence, exactly as if this optimization didn't exist for that
  // one event.
  wakeRestaurant(params.restaurantId);

  // Opportunistic pruning — this table has no natural TTL and nothing else
  // in this codebase runs a reliable background cron (see the scheduled-
  // tasks tooling note: real cron here means a schedule that survives
  // outside this process, not a setInterval in a serverless function that
  // gets frozen between requests). Rather than stand up new infrastructure
  // for a housekeeping job, every publish has a small chance of deleting
  // its own restaurant's events older than 2 hours — cheap, self-healing,
  // and only ever removes rows no SSE connection could still need (every
  // connection caps itself at MAX_STREAM_DURATION_MS, far under an hour).
  if (Math.random() < 0.02) {
    const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await handle
      .delete(realtimeEvents)
      .where(and(eq(realtimeEvents.restaurantId, params.restaurantId), lt(realtimeEvents.createdAt, cutoff)));
  }
}

type StoredEvent = { id: number; type: string; payload: unknown };

/** The most recent event id for a restaurant — used as the starting cursor
 * for a brand-new SSE connection (no Last-Event-ID header yet) so a client
 * that just opened the stream gets only what happens from now on, not a
 * replay of everything since the table's first row. */
export async function getLatestEventId(restaurantId: string): Promise<number> {
  const rows = await db
    .select({ id: realtimeEvents.id })
    .from(realtimeEvents)
    .where(eq(realtimeEvents.restaurantId, restaurantId))
    .orderBy(desc(realtimeEvents.id))
    .limit(1);
  return rows[0]?.id ?? 0;
}

/**
 * Restaurant-scoped fetch used by the staff SSE route. `branchId` is the
 * CALLER's own scope (from resolveRestaurantContext) — null means
 * unrestricted (owner/manager/platform_admin), so both restaurant-wide
 * events (branchId IS NULL) and this caller's own branch's events pass;
 * a branch-scoped caller (waiter, kitchen_staff) only ever sees
 * restaurant-wide events plus their own branch's.
 */
export function fetchEventsForRestaurant(restaurantId: string, callerBranchId: string | null) {
  return async (afterId: number): Promise<StoredEvent[]> => {
    const rows = await db
      .select({
        id: realtimeEvents.id,
        branchId: realtimeEvents.branchId,
        type: realtimeEvents.type,
        payload: realtimeEvents.payload,
      })
      .from(realtimeEvents)
      .where(and(eq(realtimeEvents.restaurantId, restaurantId), gt(realtimeEvents.id, afterId)))
      .orderBy(asc(realtimeEvents.id))
      .limit(200);

    const scoped = callerBranchId
      ? rows.filter((r) => r.branchId === null || r.branchId === callerBranchId)
      : rows;

    return scoped.map((r) => ({ id: r.id, type: r.type, payload: r.payload }));
  };
}

/**
 * Table-scoped fetch used by the public QR-menu SSE route (a guest watching
 * their own service call's status). Restricted to `service_call.*` event
 * types only — a guest's stream must never leak order-lifecycle events for
 * other guests' orders at the same restaurant, even though those events
 * technically flow through the same restaurant-scoped log.
 */
export function fetchServiceCallEventsForTable(restaurantId: string, tableId: string) {
  return async (afterId: number): Promise<StoredEvent[]> => {
    const rows = await db
      .select({
        id: realtimeEvents.id,
        type: realtimeEvents.type,
        payload: realtimeEvents.payload,
      })
      .from(realtimeEvents)
      .where(and(eq(realtimeEvents.restaurantId, restaurantId), gt(realtimeEvents.id, afterId)))
      .orderBy(asc(realtimeEvents.id))
      .limit(200);

    return rows.filter((r) => {
      if (!r.type.startsWith("service_call.")) return false;
      const payload = r.payload as { tableId?: string } | null;
      return payload?.tableId === tableId;
    });
  };
}

const DEFAULT_POLL_INTERVAL_MS = 1000;
// Serverless function invocations have hard execution time limits (Netlify
// Functions default to ~10s on the free tier, up to 26s elsewhere; Vercel's
// Hobby plan caps at 10s too). 20s keeps this comfortably inside all of
// those so the stream ends cleanly on its own terms — a `controller.close()`
// — rather than being killed mid-response. EventSource auto-reconnects
// (browser-native, no client code needed) the instant the response ends, so
// in practice this reads as one continuous connection with an imperceptible
// ~20s reconnect blip, not a visible outage.
const DEFAULT_MAX_DURATION_MS = 20_000;
const HEARTBEAT_MS = 15_000;

/**
 * Builds the actual `ReadableStream<Uint8Array>` an SSE route responds
 * with. `fetchEvents(afterId)` is one of the two scoped fetchers above.
 * `initialCursor` should come from the request's `Last-Event-ID` header
 * when present (a reconnect — resume exactly where the last connection left
 * off, so no event is missed across the reconnect gap) and otherwise from
 * `getLatestEventId`/an explicit "now" cursor (a fresh connection — start
 * from here, don't replay history). `wakeKey` is what `publishEvent` wakes
 * (the restaurant id) — this connection re-polls immediately when it fires,
 * instead of unconditionally sitting out the rest of DEFAULT_POLL_INTERVAL_MS.
 */
export function createEventStream(params: {
  fetchEvents: (afterId: number) => Promise<StoredEvent[]>;
  initialCursor: number;
  wakeKey: string;
}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      let cursor = params.initialCursor;
      let lastSentAt = Date.now();
      const startedAt = Date.now();

      controller.enqueue(encoder.encode(`retry: 2000\n\n`));

      while (true) {
        if (Date.now() - startedAt > DEFAULT_MAX_DURATION_MS) break;

        try {
          const events = await params.fetchEvents(cursor);
          for (const event of events) {
            cursor = event.id;
            controller.enqueue(
              encoder.encode(
                `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`,
              ),
            );
            lastSentAt = Date.now();
          }
        } catch (err) {
          // A transient DB hiccup shouldn't kill the connection — log
          // server-side and keep polling; the client never sees this and
          // just gets the next successful poll's events (or a heartbeat).
          console.error("SSE poll failed:", err);
        }

        if (Date.now() - lastSentAt > HEARTBEAT_MS) {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
          lastSentAt = Date.now();
        }

        await waitForWake(params.wakeKey, DEFAULT_POLL_INTERVAL_MS);
      }

      controller.close();
    },
    cancel() {
      // The client navigated away or the browser dropped the connection —
      // nothing to clean up beyond letting the async generator above exit
      // on its own next loop check, since there's no external resource
      // (no held DB connection, no timer outside this closure) to release.
    },
  });
}

export const SSE_RESPONSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  // Disables response buffering on Nginx-fronted deployments — without it,
  // a reverse proxy can hold the whole response until it closes, which
  // defeats the point of a stream.
  "X-Accel-Buffering": "no",
};
