/**
 * Phase 22 (offline mode) — unit tests for the IndexedDB-backed order
 * status-update queue (src/lib/offline-status-queue.ts). Same fake-indexeddb
 * approach as offline-queue.test.ts (see its own comment for why) — this
 * exercises the real async IDBRequest/transaction machinery, not a shallow
 * mock.
 */
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import {
  enqueueStatusUpdate,
  isOfflineQueueSupported,
  listQueuedStatusUpdates,
  removeQueuedStatusUpdate,
  syncQueuedStatusUpdates,
} from "./offline-status-queue";
import type { OrderStatus } from "./order-status";

function uniqueSlug(name: string) {
  return `${name}-${Math.random().toString(36).slice(2, 8)}`;
}

function baseUpdate(overrides: Partial<Parameters<typeof enqueueStatusUpdate>[0]> = {}) {
  return {
    slug: uniqueSlug("cafe"),
    orderId: crypto.randomUUID(),
    orderNumber: "1001",
    fromStatus: "confirmed" as OrderStatus,
    toStatus: "preparing" as OrderStatus,
    ...overrides,
  };
}

describe("offline-status-queue", () => {
  it("reports support once fake-indexeddb is installed", () => {
    expect(isOfflineQueueSupported()).toBe(true);
  });

  it("enqueues a status change and lists it back for the right slug only", async () => {
    const slugA = uniqueSlug("cafe-a");
    const slugB = uniqueSlug("cafe-b");
    await enqueueStatusUpdate(baseUpdate({ slug: slugA }));

    const forA = await listQueuedStatusUpdates(slugA);
    const forB = await listQueuedStatusUpdates(slugB);
    expect(forA).toHaveLength(1);
    expect(forA[0].status).toBe("pending");
    expect(forA[0].toStatus).toBe("preparing");
    expect(forB).toHaveLength(0);
  });

  it("lists queued updates oldest-first", async () => {
    const slug = uniqueSlug("order");
    await enqueueStatusUpdate(baseUpdate({ slug, orderNumber: "1" }));
    await enqueueStatusUpdate(baseUpdate({ slug, orderNumber: "2" }));

    const rows = await listQueuedStatusUpdates(slug);
    expect(rows.map((r) => r.orderNumber)).toEqual(["1", "2"]);
  });

  it("removeQueuedStatusUpdate deletes exactly the targeted row", async () => {
    const slug = uniqueSlug("remove");
    const keep = await enqueueStatusUpdate(baseUpdate({ slug, orderNumber: "keep" }));
    const drop = await enqueueStatusUpdate(baseUpdate({ slug, orderNumber: "drop" }));

    await removeQueuedStatusUpdate(drop.clientRequestId);

    const rows = await listQueuedStatusUpdates(slug);
    expect(rows.map((r) => r.clientRequestId)).toEqual([keep.clientRequestId]);
  });

  describe("syncQueuedStatusUpdates", () => {
    it("removes every update that applies successfully", async () => {
      const slug = uniqueSlug("sync-ok");
      await enqueueStatusUpdate(baseUpdate({ slug }));
      await enqueueStatusUpdate(baseUpdate({ slug }));

      const result = await syncQueuedStatusUpdates(slug, {
        applyStatus: async () => {},
        getCurrentStatus: async () => "preparing",
      });

      expect(result).toEqual({ synced: 2, failed: 0, stillOffline: false });
      expect(await listQueuedStatusUpdates(slug)).toHaveLength(0);
    });

    it("treats a 409-style conflict as already-applied when the order is already at the target status", async () => {
      const slug = uniqueSlug("sync-already");
      await enqueueStatusUpdate(baseUpdate({ slug, toStatus: "preparing" }));

      const result = await syncQueuedStatusUpdates(slug, {
        applyStatus: async () => {
          throw new Error("This order's status was just changed by someone else.");
        },
        getCurrentStatus: async () => "preparing", // our own earlier attempt actually landed
      });

      expect(result).toEqual({ synced: 1, failed: 0, stillOffline: false });
      expect(await listQueuedStatusUpdates(slug)).toHaveLength(0);
    });

    it("treats the order having moved further ahead as already-applied (moot, not a failure)", async () => {
      const slug = uniqueSlug("sync-ahead");
      await enqueueStatusUpdate(baseUpdate({ slug, fromStatus: "confirmed", toStatus: "preparing" }));

      const result = await syncQueuedStatusUpdates(slug, {
        applyStatus: async () => {
          throw new Error("Cannot move an order from \"ready\" to \"preparing\".");
        },
        getCurrentStatus: async () => "served", // someone else already advanced it past "preparing"
      });

      expect(result).toEqual({ synced: 1, failed: 0, stillOffline: false });
    });

    it("never treats a cancelled order as ahead of a forward status", async () => {
      const slug = uniqueSlug("sync-cancelled");
      await enqueueStatusUpdate(baseUpdate({ slug, fromStatus: "confirmed", toStatus: "preparing" }));

      const result = await syncQueuedStatusUpdates(slug, {
        applyStatus: async () => {
          throw new Error("Cannot move an order from \"cancelled\" to \"preparing\".");
        },
        getCurrentStatus: async () => "cancelled",
      });

      expect(result).toEqual({ synced: 0, failed: 1, stillOffline: false });
      const rows = await listQueuedStatusUpdates(slug);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("error");
    });

    it("keeps a genuinely failed update in the queue, marked with its error", async () => {
      const slug = uniqueSlug("sync-fail");
      await enqueueStatusUpdate(baseUpdate({ slug, toStatus: "preparing" }));

      const result = await syncQueuedStatusUpdates(slug, {
        applyStatus: async () => {
          throw new Error("You don't have permission to do that.");
        },
        getCurrentStatus: async () => "confirmed", // unchanged — a genuine conflict, not a moot retry
      });

      expect(result).toEqual({ synced: 0, failed: 1, stillOffline: false });
      const rows = await listQueuedStatusUpdates(slug);
      expect(rows[0].status).toBe("error");
      expect(rows[0].lastError).toBe("You don't have permission to do that.");
      expect(rows[0].attempts).toBe(1);
    });

    it("stops and reports stillOffline when the reconciliation check itself can't reach the server", async () => {
      const slug = uniqueSlug("sync-offline");
      await enqueueStatusUpdate(baseUpdate({ slug }));
      await enqueueStatusUpdate(baseUpdate({ slug }));

      const result = await syncQueuedStatusUpdates(slug, {
        applyStatus: async () => {
          throw new Error("Network unreachable");
        },
        getCurrentStatus: async () => {
          throw new Error("Network unreachable");
        },
      });

      expect(result).toEqual({ synced: 0, failed: 0, stillOffline: true });
      const rows = await listQueuedStatusUpdates(slug);
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.status === "pending")).toBe(true);
    });

    it("processes updates independently until a genuine failure, one bad update doesn't corrupt the others", async () => {
      const slug = uniqueSlug("sync-mixed");
      await enqueueStatusUpdate(baseUpdate({ slug, orderNumber: "ok-1" }));
      await enqueueStatusUpdate(baseUpdate({ slug, orderNumber: "ok-2" }));

      const result = await syncQueuedStatusUpdates(slug, {
        applyStatus: async (update) => {
          if (update.orderNumber === "ok-2") throw new Error("boom");
        },
        getCurrentStatus: async () => "confirmed",
      });

      expect(result).toEqual({ synced: 1, failed: 1, stillOffline: false });
      const rows = await listQueuedStatusUpdates(slug);
      expect(rows.map((r) => r.orderNumber)).toEqual(["ok-2"]);
    });
  });
});
