import "server-only";
import { and, asc, desc, eq, gt, lt } from "drizzle-orm";
import type { Database, Transaction } from "@/db";
import { db } from "@/db";
import { realtimeEvents } from "@/db/schema";

/**
 * Real-time event bus, backed by the database instead of in-memory pub/sub.
 *
 * Why: this app deploys as serverless functions (Netlify Functions /
 * Vercel), not one long-running Node process — see the schema.ts comment
 * above `realtimeEvents` for the full reasoning, and rate-limit.ts for the
 * same caveat already documented elsewhere in this codebase. An in-memory
 * EventEmitter would silently drop every event published from a different
 * invocation than the one holding the SSE connection open, which in a
 * serverless deployment is the common case, not an edge case. Routing every
 * event through a table both instances can see sidesteps that entirely, at
 * the cost of being "DB-polling under an SSE connection" rather than a true
 * push channel. That's still a big, honest improvement over the client
 * polling every 5s: staff never issue a request to learn about a new order
 * or a service call — the already-open connection delivers it, typically
 * within one poll interval (~1s).
 */

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
 * from here, don't replay history).
 */
export function createEventStream(params: {
  fetchEvents: (afterId: number) => Promise<StoredEvent[]>;
  initialCursor: number;
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

        await new Promise((resolve) => setTimeout(resolve, DEFAULT_POLL_INTERVAL_MS));
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
