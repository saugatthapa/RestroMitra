/**
 * Phase 11b — Offline POS: unit tests for the IndexedDB-backed order queue
 * (src/lib/offline-queue.ts). Runs against `fake-indexeddb`, a spec-faithful
 * in-memory IndexedDB implementation, so these exercise the real async
 * IDBRequest/transaction machinery rather than a hand-rolled mock — the
 * queue's correctness depends on getting that machinery right (a botched
 * transaction lifetime is exactly the kind of bug a shallow mock would miss).
 */
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import {
  enqueueOrder,
  isOfflineQueueSupported,
  listQueuedOrders,
  removeQueuedOrder,
  syncQueuedOrders,
} from "./offline-queue";

// fake-indexeddb persists across the whole process; each test gets a
// distinct slug so their queues never see each other's rows without having
// to reset the whole database between tests.
function uniqueSlug(name: string) {
  return `${name}-${Math.random().toString(36).slice(2, 8)}`;
}

describe("offline-queue", () => {
  it("reports support once fake-indexeddb is installed", () => {
    expect(isOfflineQueueSupported()).toBe(true);
  });

  it("enqueues an order and lists it back for the right slug only", async () => {
    const slugA = uniqueSlug("cafe-a");
    const slugB = uniqueSlug("cafe-b");
    const id = crypto.randomUUID();
    await enqueueOrder(slugA, id, { items: [{ menuItemId: "x", quantity: 1 }] }, {
      itemCount: 1,
      totalLabel: "Rs 100",
    });

    const forA = await listQueuedOrders(slugA);
    const forB = await listQueuedOrders(slugB);
    expect(forA).toHaveLength(1);
    expect(forA[0].clientRequestId).toBe(id);
    expect(forA[0].status).toBe("pending");
    expect(forA[0].summary.totalLabel).toBe("Rs 100");
    expect(forB).toHaveLength(0);
  });

  it("lists queued orders oldest-first", async () => {
    const slug = uniqueSlug("order");
    const first = crypto.randomUUID();
    await enqueueOrder(slug, first, { a: 1 }, { itemCount: 1, totalLabel: "Rs 10" });
    // Force a distinct createdAt ordering without relying on real timing —
    // the module stamps createdAt itself, so instead just confirm both rows
    // are present and stably sortable by insertion; a same-millisecond
    // collision would still sort deterministically via localeCompare.
    const second = crypto.randomUUID();
    await enqueueOrder(slug, second, { a: 2 }, { itemCount: 1, totalLabel: "Rs 20" });

    const rows = await listQueuedOrders(slug);
    expect(rows.map((r) => r.clientRequestId)).toEqual([first, second]);
  });

  it("removeQueuedOrder deletes exactly the targeted row", async () => {
    const slug = uniqueSlug("remove");
    const keep = crypto.randomUUID();
    const drop = crypto.randomUUID();
    await enqueueOrder(slug, keep, {}, { itemCount: 1, totalLabel: "Rs 10" });
    await enqueueOrder(slug, drop, {}, { itemCount: 1, totalLabel: "Rs 20" });

    await removeQueuedOrder(drop);

    const rows = await listQueuedOrders(slug);
    expect(rows.map((r) => r.clientRequestId)).toEqual([keep]);
  });

  describe("syncQueuedOrders", () => {
    it("removes every order that submits successfully", async () => {
      const slug = uniqueSlug("sync-ok");
      await enqueueOrder(slug, crypto.randomUUID(), { a: 1 }, { itemCount: 1, totalLabel: "Rs 10" });
      await enqueueOrder(slug, crypto.randomUUID(), { a: 2 }, { itemCount: 1, totalLabel: "Rs 20" });

      const result = await syncQueuedOrders(slug, async () => {
        /* pretend the POST succeeded */
      });

      expect(result).toEqual({ synced: 2, failed: 0 });
      expect(await listQueuedOrders(slug)).toHaveLength(0);
    });

    it("keeps a failed order in the queue, marked with its error", async () => {
      const slug = uniqueSlug("sync-fail");
      const id = crypto.randomUUID();
      await enqueueOrder(slug, id, { a: 1 }, { itemCount: 1, totalLabel: "Rs 10" });

      const result = await syncQueuedOrders(slug, async () => {
        throw new Error("Network unreachable");
      });

      expect(result).toEqual({ synced: 0, failed: 1 });
      const rows = await listQueuedOrders(slug);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("error");
      expect(rows[0].lastError).toBe("Network unreachable");
      expect(rows[0].attempts).toBe(1);
    });

    it("processes each order independently — one failure doesn't block the rest", async () => {
      const slug = uniqueSlug("sync-mixed");
      const failing = crypto.randomUUID();
      const ok1 = crypto.randomUUID();
      const ok2 = crypto.randomUUID();
      await enqueueOrder(slug, failing, { fail: true }, { itemCount: 1, totalLabel: "Rs 10" });
      await enqueueOrder(slug, ok1, { fail: false }, { itemCount: 1, totalLabel: "Rs 20" });
      await enqueueOrder(slug, ok2, { fail: false }, { itemCount: 1, totalLabel: "Rs 30" });

      const result = await syncQueuedOrders(slug, async (payload) => {
        if ((payload as { fail: boolean }).fail) throw new Error("boom");
      });

      expect(result).toEqual({ synced: 2, failed: 1 });
      const rows = await listQueuedOrders(slug);
      expect(rows.map((r) => r.clientRequestId)).toEqual([failing]);
    });

    it("retrying a previously-failed order increments its attempt count", async () => {
      const slug = uniqueSlug("sync-retry");
      const id = crypto.randomUUID();
      await enqueueOrder(slug, id, {}, { itemCount: 1, totalLabel: "Rs 10" });

      await syncQueuedOrders(slug, async () => {
        throw new Error("first failure");
      });
      await syncQueuedOrders(slug, async () => {
        throw new Error("second failure");
      });

      const rows = await listQueuedOrders(slug);
      expect(rows[0].attempts).toBe(2);
      expect(rows[0].lastError).toBe("second failure");
    });
  });
});
