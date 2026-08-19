"use client";

/**
 * Phase 22 (offline mode) — an IndexedDB-backed queue for order STATUS
 * changes (confirm / start preparing / mark ready / mark served / cancel)
 * made from the Orders board or KDS while offline, mirroring the pattern
 * offline-queue.ts already established for POS order creation (Phase 11b)
 * but deliberately NOT sharing its database — status updates and new-order
 * payloads are different enough shapes that a second small IndexedDB
 * database is a better tradeoff here than generalizing the existing one,
 * and it leaves the already-shipped, tested POS queue completely untouched.
 *
 * Payment-linked completion (an unpaid order being marked "completed") is
 * deliberately NOT queueable here — see OrdersBoard.tsx's handleAdvance,
 * which routes that case through OrderPaymentModal instead, a flow this
 * queue doesn't attempt to make offline-capable (recording money offline is
 * a materially bigger risk than flipping a status label, and out of scope
 * for this pass).
 *
 * Idempotency works differently here than order creation's clientRequestId
 * lookup: the status-update endpoint uses a compare-and-swap on the
 * order's CURRENT status (see that route's own comment on why), so
 * retrying an update that actually already landed gets a 409 rather than a
 * silent no-op success. syncQueuedStatusUpdates handles that by re-reading
 * the order's current status on ANY apply failure (not just a 409 — a
 * plain validation error reconciles the same way, harmlessly) and treating
 * "already at, or already past, the target status" as done rather than as
 * an error — see rankOf()'s comment below for exactly what "past" means.
 */

import { ORDER_STATUSES, type OrderStatus } from "./order-status";

const DB_NAME = "dhankipos-offline-status";
const DB_VERSION = 1;
const STORE = "pending_status_updates";

export type QueuedStatusUpdateState = "pending" | "syncing" | "error";

export type QueuedStatusUpdate = {
  clientRequestId: string;
  slug: string;
  orderId: string;
  orderNumber: string;
  fromStatus: OrderStatus;
  toStatus: OrderStatus;
  reason: string | null;
  createdAt: string;
  status: QueuedStatusUpdateState;
  attempts: number;
  lastError: string | null;
};

// `new Date().toISOString()` alone is only millisecond-resolution — two
// enqueueStatusUpdate() calls issued back-to-back (a common case: this
// module's own tests enqueue two updates with no await/delay between them,
// and in practice a staff member could tap "confirm" then "mark ready" on
// two different orders within the same millisecond) can tie. A tied
// `createdAt` makes listQueuedStatusUpdates's sort a no-op for those two
// rows, silently falling back to whatever order IndexedDB happened to
// enumerate them in — not guaranteed to be insertion order. A zero-padded,
// monotonically-increasing in-memory counter appended to the timestamp
// breaks that tie deterministically (lexicographic string comparison stays
// correct as long as the suffix is fixed-width) without needing IndexedDB's
// own autoIncrement machinery, which only applies to out-of-line keys and
// this store already uses clientRequestId as its keyPath.
let createdAtSequence = 0;
function nextCreatedAt(): string {
  createdAtSequence = (createdAtSequence + 1) % 1_000_000;
  return `${new Date().toISOString()}#${String(createdAtSequence).padStart(6, "0")}`;
}

export function isOfflineQueueSupported(): boolean {
  // Checked as a bare global, not `window.indexedDB` — see offline-queue.ts's
  // identical comment on why (works under the fake-indexeddb test polyfill,
  // which has no `window`, too).
  return typeof indexedDB !== "undefined";
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!isOfflineQueueSupported()) {
      reject(new Error("IndexedDB is not available in this browser."));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "clientRequestId" });
        store.createIndex("slug", "slug", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Could not open the offline queue."));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      const req = fn(store);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("Offline queue operation failed."));
    });
  } finally {
    db.close();
  }
}

export async function enqueueStatusUpdate(input: {
  slug: string;
  orderId: string;
  orderNumber: string;
  fromStatus: OrderStatus;
  toStatus: OrderStatus;
  reason?: string | null;
}): Promise<QueuedStatusUpdate> {
  const record: QueuedStatusUpdate = {
    clientRequestId: crypto.randomUUID(),
    slug: input.slug,
    orderId: input.orderId,
    orderNumber: input.orderNumber,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    reason: input.reason ?? null,
    createdAt: nextCreatedAt(),
    status: "pending",
    attempts: 0,
    lastError: null,
  };
  await withStore("readwrite", (store) => store.put(record));
  return record;
}

export async function listQueuedStatusUpdates(slug: string): Promise<QueuedStatusUpdate[]> {
  if (!isOfflineQueueSupported()) return [];
  const all = await withStore<QueuedStatusUpdate[]>("readonly", (store) => store.getAll());
  return all
    .filter((o) => o.slug === slug)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function removeQueuedStatusUpdate(clientRequestId: string): Promise<void> {
  await withStore("readwrite", (store) => store.delete(clientRequestId));
}

async function updateQueuedStatusUpdate(
  clientRequestId: string,
  patch: Partial<Pick<QueuedStatusUpdate, "status" | "attempts" | "lastError">>,
): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const getReq = store.get(clientRequestId);
      getReq.onsuccess = () => {
        const existing = getReq.result as QueuedStatusUpdate | undefined;
        if (!existing) {
          resolve();
          return;
        }
        const putReq = store.put({ ...existing, ...patch });
        putReq.onsuccess = () => resolve();
        putReq.onerror = () =>
          reject(putReq.error ?? new Error("Could not update queued status change."));
      };
      getReq.onerror = () => reject(getReq.error ?? new Error("Could not read queued status change."));
    });
  } finally {
    db.close();
  }
}

export type StatusSyncResult = { synced: number; failed: number; stillOffline: boolean };

// The forward status order, EXCLUDING "cancelled" — used only to detect
// whether an order has already progressed PAST a queued target (e.g. this
// device queued "mark ready" but another device already advanced the same
// order to "served" while this one was offline, so the queued update is
// moot, not failed). "cancelled" is deliberately excluded from this rank
// entirely rather than sitting at the end of ORDER_STATUSES's array order
// — it isn't "ahead of" completed/served/etc. in any meaningful sense, so
// letting it rank there would wrongly treat "the order got cancelled" as
// "the order already got the update we wanted."
const FORWARD_RANK: Partial<Record<OrderStatus, number>> = Object.fromEntries(
  ORDER_STATUSES.filter((s) => s !== "cancelled").map((s, i) => [s, i]),
);

/**
 * Attempts to apply every queued status change for `slug`, oldest first.
 * `applyStatus` is injected (same reasoning as syncQueuedOrders in
 * offline-queue.ts) so this stays trivially testable without a network
 * mock; `getCurrentStatus` is a second injected call used ONLY when
 * `applyStatus` fails, to tell a genuine conflict apart from a retry of an
 * update that actually already landed (see the module comment above).
 *
 * `getCurrentStatus` itself failing (thrown, not returned) means the
 * device is still offline (or offline again already) — the item that
 * triggered the check is left exactly as it was ("pending", not "error"),
 * the rest of the queue is left untouched, and this returns immediately
 * rather than letting every remaining item fail the exact same way.
 */
export async function syncQueuedStatusUpdates(
  slug: string,
  deps: {
    applyStatus: (update: QueuedStatusUpdate) => Promise<void>;
    getCurrentStatus: (orderId: string) => Promise<OrderStatus | null>;
  },
): Promise<StatusSyncResult> {
  const queued = await listQueuedStatusUpdates(slug);
  let synced = 0;
  let failed = 0;

  for (const update of queued) {
    await updateQueuedStatusUpdate(update.clientRequestId, { status: "syncing" });
    try {
      await deps.applyStatus(update);
      await removeQueuedStatusUpdate(update.clientRequestId);
      synced++;
      continue;
    } catch (err) {
      let current: OrderStatus | null;
      try {
        current = await deps.getCurrentStatus(update.orderId);
      } catch {
        await updateQueuedStatusUpdate(update.clientRequestId, { status: "pending" });
        return { synced, failed, stillOffline: true };
      }

      const targetRank = FORWARD_RANK[update.toStatus];
      const currentRank = current === null ? undefined : FORWARD_RANK[current];
      const alreadyApplied =
        current !== null &&
        (current === update.toStatus ||
          (targetRank !== undefined && currentRank !== undefined && currentRank > targetRank));

      if (alreadyApplied) {
        await removeQueuedStatusUpdate(update.clientRequestId);
        synced++;
        continue;
      }

      failed++;
      await updateQueuedStatusUpdate(update.clientRequestId, {
        status: "error",
        attempts: update.attempts + 1,
        lastError: err instanceof Error ? err.message : "Sync failed.",
      });
    }
  }

  return { synced, failed, stillOffline: false };
}
