"use client";

/**
 * Phase 11b — Offline POS: a browser-only IndexedDB-backed queue for staff
 * orders taken while the device has no network connection (or the POST just
 * timed out). Nothing here ever runs server-side — every export either no-ops
 * or throws if `indexedDB` isn't available, so importing this module in a
 * server component/route is safe but calling it there is a bug.
 *
 * Each queued order carries a client-generated `clientRequestId` (a UUID,
 * unrelated to the eventual server-assigned order id) that's sent to
 * POST /api/restaurants/[slug]/orders as-is. The orders route treats that
 * field as an idempotency key: replaying the same clientRequestId — which
 * happens naturally if `syncQueuedOrders` retries a request that actually
 * succeeded but whose response the device never saw (e.g. connection drops
 * mid-response) — returns the original order instead of creating a second
 * one. This queue only has to guarantee "try again until it works," not
 * "never send the same thing twice."
 */

const DB_NAME = "dhankipos-offline";
const DB_VERSION = 1;
const STORE = "pending_orders";

export type QueuedOrderStatus = "pending" | "syncing" | "error";

export type QueuedOrder = {
  clientRequestId: string;
  slug: string;
  payload: Record<string, unknown>;
  createdAt: string;
  status: QueuedOrderStatus;
  attempts: number;
  lastError: string | null;
  // A quick human-readable summary for the "pending sync" UI, so it doesn't
  // need to re-derive item names from the raw payload.
  summary: { itemCount: number; totalLabel: string };
};

// See offline-status-queue.ts's identical comment: `new Date().toISOString()`
// alone is only millisecond-resolution, so two enqueueOrder() calls issued
// back-to-back can tie and make the oldest-first sort below a no-op for
// those rows. The zero-padded counter suffix breaks the tie deterministically.
let createdAtSequence = 0;
function nextCreatedAt(): string {
  createdAtSequence = (createdAtSequence + 1) % 1_000_000;
  return `${new Date().toISOString()}#${String(createdAtSequence).padStart(6, "0")}`;
}

export function isOfflineQueueSupported(): boolean {
  // Checked as a bare global, not `window.indexedDB` — `indexedDB` is a
  // global in every context that has it (browser main thread, and the
  // fake-indexeddb polyfill this module's own tests run against), so this
  // works without requiring a `window` to exist at all.
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

export async function enqueueOrder(
  slug: string,
  clientRequestId: string,
  payload: Record<string, unknown>,
  summary: { itemCount: number; totalLabel: string },
): Promise<QueuedOrder> {
  const record: QueuedOrder = {
    clientRequestId,
    slug,
    payload,
    createdAt: nextCreatedAt(),
    status: "pending",
    attempts: 0,
    lastError: null,
    summary,
  };
  await withStore("readwrite", (store) => store.put(record));
  return record;
}

export async function listQueuedOrders(slug: string): Promise<QueuedOrder[]> {
  if (!isOfflineQueueSupported()) return [];
  const all = await withStore<QueuedOrder[]>("readonly", (store) => store.getAll());
  return all
    .filter((o) => o.slug === slug)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function removeQueuedOrder(clientRequestId: string): Promise<void> {
  await withStore("readwrite", (store) => store.delete(clientRequestId));
}

async function updateQueuedOrder(
  clientRequestId: string,
  patch: Partial<Pick<QueuedOrder, "status" | "attempts" | "lastError">>,
): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const getReq = store.get(clientRequestId);
      getReq.onsuccess = () => {
        const existing = getReq.result as QueuedOrder | undefined;
        if (!existing) {
          resolve();
          return;
        }
        const putReq = store.put({ ...existing, ...patch });
        putReq.onsuccess = () => resolve();
        putReq.onerror = () => reject(putReq.error ?? new Error("Could not update queued order."));
      };
      getReq.onerror = () => reject(getReq.error ?? new Error("Could not read queued order."));
    });
  } finally {
    db.close();
  }
}

export type SyncResult = { synced: number; failed: number };

/**
 * Attempts to submit every queued order for `slug`, in the order they were
 * created (so an offline shift's orders land in the same sequence they were
 * taken). `submit` is injected rather than hard-coding `fetch` here so this
 * module stays trivially testable without a network mock. Failures are left
 * in the queue (marked "error", with the failure reason) for the next retry
 * — either a manual "Sync now" click or the next automatic attempt — rather
 * than being dropped, since a device going offline again mid-sync is exactly
 * the situation this queue exists for.
 */
export async function syncQueuedOrders(
  slug: string,
  submit: (payload: Record<string, unknown>) => Promise<void>,
): Promise<SyncResult> {
  const queued = await listQueuedOrders(slug);
  let synced = 0;
  let failed = 0;
  for (const order of queued) {
    await updateQueuedOrder(order.clientRequestId, { status: "syncing" });
    try {
      await submit(order.payload);
      await removeQueuedOrder(order.clientRequestId);
      synced++;
    } catch (err) {
      failed++;
      await updateQueuedOrder(order.clientRequestId, {
        status: "error",
        attempts: order.attempts + 1,
        lastError: err instanceof Error ? err.message : "Sync failed.",
      });
    }
  }
  return { synced, failed };
}
