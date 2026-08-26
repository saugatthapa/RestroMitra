/**
 * Commercial-launch Phase A.7 (Stock Transfer) integration tests for
 * src/lib/stock-transfer.ts — createStockTransfer/approveStockTransfer/
 * dispatchStockTransfer/receiveStockTransfer/cancelStockTransfer/
 * getStockTransferDetail/listStockTransfers.
 *
 * Same convention as stock-count.test.ts/supplier-dues.test.ts (see their
 * own doc comments): RBAC/tenant/branch scoping for
 * resolveRestaurantContext()/requireBranchAccess()/requireEitherBranchAccess()
 * is covered by rbac/guard's own tests, so this file exercises the business
 * logic directly — the requested -> approved -> dispatched -> received |
 * cancelled state machine, the actual stock-ledger effect at dispatch/
 * receive (including a partial-receive discrepancy), tenant/branch
 * isolation, validation failures, concurrency, and rollback.
 *
 * Skipped (not failed) when DATABASE_URL isn't set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Stock transfer (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let st: typeof import("@/lib/stock-transfer");

  let restaurantId: string;
  let otherRestaurantId: string;
  let branchAId: string;
  let branchBId: string;
  let branchCId: string;
  let otherRestaurantBranchId: string;
  let userId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    st = await import("@/lib/stock-transfer");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-stock-transfer-${suffix}`, name: "TEST Stock Transfer Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [otherRestaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-stock-transfer-other-${suffix}`, name: "TEST Other Restaurant" })
      .returning({ id: schema.restaurants.id });
    otherRestaurantId = otherRestaurant.id;

    const [branchA] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Branch A", isMain: true })
      .returning({ id: schema.branches.id });
    branchAId = branchA.id;

    const [branchB] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Branch B", isMain: false })
      .returning({ id: schema.branches.id });
    branchBId = branchB.id;

    const [branchC] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Branch C", isMain: false })
      .returning({ id: schema.branches.id });
    branchCId = branchC.id;

    const [otherBranch] = await db
      .insert(schema.branches)
      .values({ restaurantId: otherRestaurantId, name: "Other Main", isMain: true })
      .returning({ id: schema.branches.id });
    otherRestaurantBranchId = otherBranch.id;

    const [user] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Stock Transfer User", phone: `975${suffix}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    userId = user.id;
  });

  afterAll(async () => {
    // stock_transfer_items.inventoryItemId is ON DELETE RESTRICT — same
    // cleanup-ordering pattern as every other inventory integration test
    // in this project: delete stock_transfers (cascades stock_transfer_items)
    // then the inventory items, before the restaurant.
    await db.delete(schema.stockTransfers).where(eq(schema.stockTransfers.restaurantId, restaurantId));
    await db.delete(schema.inventoryItems).where(eq(schema.inventoryItems.restaurantId, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
    await db.delete(schema.stockTransfers).where(eq(schema.stockTransfers.restaurantId, otherRestaurantId));
    await db.delete(schema.inventoryItems).where(eq(schema.inventoryItems.restaurantId, otherRestaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, otherRestaurantId));
  });

  /** Fresh item per test, same reasoning as stock-count.test.ts's createItem — running branch stock totals must never be shared across tests. */
  async function createItem(costPerUnitInPaisa = 100) {
    const suffix = Math.random().toString(36).slice(2, 8);
    const [item] = await db
      .insert(schema.inventoryItems)
      .values({ restaurantId, name: `TEST Transfer Item ${suffix}`, unit: "kg", costPerUnitInPaisa })
      .returning({ id: schema.inventoryItems.id });
    return item.id;
  }

  async function setSystemStock(itemId: string, branchId: string, quantityMilliunits: number) {
    const inventoryLib = await import("@/lib/inventory");
    await db.transaction((tx) =>
      inventoryLib.recordStockMovement(tx, {
        restaurantId,
        branchId,
        inventoryItemId: itemId,
        type: "adjustment",
        quantityDeltaMilliunits: quantityMilliunits,
        note: "TEST seed system stock",
        recordedByUserId: userId,
      }),
    );
  }

  it("happy path: full lifecycle requested -> approved -> dispatched -> received moves stock from source to destination branch", async () => {
    const itemId = await createItem(5_000);
    await setSystemStock(itemId, branchAId, 10_000); // 10kg at Branch A

    const created = await st.createStockTransfer({
      restaurantId,
      fromBranchId: branchAId,
      toBranchId: branchBId,
      requestedByUserId: userId,
      notes: "TEST weekly restock",
      items: [{ inventoryItemId: itemId, quantityMilliunits: 4_000 }],
    });
    expect(created.transfer.status).toBe("requested");
    expect(created.items).toHaveLength(1);

    const approved = await db.transaction((tx) =>
      st.approveStockTransfer(tx, { restaurantId, stockTransferId: created.transfer.id, approvedByUserId: userId }),
    );
    expect(approved.status).toBe("approved");

    const dispatched = await db.transaction((tx) =>
      st.dispatchStockTransfer(tx, { restaurantId, stockTransferId: created.transfer.id, dispatchedByUserId: userId }),
    );
    expect(dispatched.transfer.status).toBe("dispatched");
    expect(dispatched.dispatchedItemCount).toBe(1);

    const [fromLevelAfterDispatch] = await db
      .select({ qty: schema.branchInventoryLevels.currentStockMilliunits })
      .from(schema.branchInventoryLevels)
      .where(and(eq(schema.branchInventoryLevels.branchId, branchAId), eq(schema.branchInventoryLevels.inventoryItemId, itemId)));
    expect(fromLevelAfterDispatch.qty).toBe(6_000); // 10kg - 4kg dispatched

    // Not yet at the destination.
    const toLevelBeforeReceive = await db
      .select()
      .from(schema.branchInventoryLevels)
      .where(and(eq(schema.branchInventoryLevels.branchId, branchBId), eq(schema.branchInventoryLevels.inventoryItemId, itemId)));
    expect(toLevelBeforeReceive).toHaveLength(0);

    const received = await db.transaction((tx) =>
      st.receiveStockTransfer(tx, { restaurantId, stockTransferId: created.transfer.id, receivedByUserId: userId }),
    );
    expect(received.transfer.status).toBe("received");
    expect(received.receivedLineCount).toBe(1);

    const [toLevelAfterReceive] = await db
      .select({ qty: schema.branchInventoryLevels.currentStockMilliunits })
      .from(schema.branchInventoryLevels)
      .where(and(eq(schema.branchInventoryLevels.branchId, branchBId), eq(schema.branchInventoryLevels.inventoryItemId, itemId)));
    expect(toLevelAfterReceive.qty).toBe(4_000);

    const [movementOut] = await db
      .select()
      .from(schema.stockMovements)
      .where(eq(schema.stockMovements.referenceId, created.transfer.id))
      .then((rows) => rows.filter((r) => r.type === "transfer_out"));
    expect(movementOut.quantityDeltaMilliunits).toBe(-4_000);
    const [movementIn] = await db
      .select()
      .from(schema.stockMovements)
      .where(eq(schema.stockMovements.referenceId, created.transfer.id))
      .then((rows) => rows.filter((r) => r.type === "transfer_in"));
    expect(movementIn.quantityDeltaMilliunits).toBe(4_000);
  });

  it("partial receive: a discrepancy between dispatched and received quantity is recorded and only the actually-received amount lands at the destination", async () => {
    const itemId = await createItem();
    await setSystemStock(itemId, branchAId, 5_000);

    const created = await st.createStockTransfer({
      restaurantId,
      fromBranchId: branchAId,
      toBranchId: branchCId,
      requestedByUserId: userId,
      items: [{ inventoryItemId: itemId, quantityMilliunits: 3_000 }],
    });
    await db.transaction((tx) => st.approveStockTransfer(tx, { restaurantId, stockTransferId: created.transfer.id, approvedByUserId: userId }));
    await db.transaction((tx) => st.dispatchStockTransfer(tx, { restaurantId, stockTransferId: created.transfer.id, dispatchedByUserId: userId }));

    const received = await db.transaction((tx) =>
      st.receiveStockTransfer(tx, {
        restaurantId,
        stockTransferId: created.transfer.id,
        receivedByUserId: userId,
        items: [{ stockTransferItemId: created.items[0].id, receivedQuantityMilliunits: 2_500, note: "TEST 0.5kg spilled in transit" }],
      }),
    );
    expect(received.transfer.status).toBe("received");

    const [line] = await db.select().from(schema.stockTransferItems).where(eq(schema.stockTransferItems.id, created.items[0].id));
    expect(line.quantityMilliunits).toBe(3_000); // what was dispatched, unchanged
    expect(line.receivedQuantityMilliunits).toBe(2_500); // what actually arrived
    expect(line.note).toBe("TEST 0.5kg spilled in transit");

    const [toLevel] = await db
      .select({ qty: schema.branchInventoryLevels.currentStockMilliunits })
      .from(schema.branchInventoryLevels)
      .where(and(eq(schema.branchInventoryLevels.branchId, branchCId), eq(schema.branchInventoryLevels.inventoryItemId, itemId)));
    expect(toLevel.qty).toBe(2_500); // only the actually-received amount, not the dispatched 3_000
  });

  it("receiving a fully-lost line (received quantity 0) writes no transfer_in movement for that line", async () => {
    const itemId = await createItem();
    await setSystemStock(itemId, branchAId, 2_000);
    const created = await st.createStockTransfer({
      restaurantId,
      fromBranchId: branchAId,
      toBranchId: branchBId,
      requestedByUserId: userId,
      items: [{ inventoryItemId: itemId, quantityMilliunits: 1_000 }],
    });
    await db.transaction((tx) => st.approveStockTransfer(tx, { restaurantId, stockTransferId: created.transfer.id, approvedByUserId: userId }));
    await db.transaction((tx) => st.dispatchStockTransfer(tx, { restaurantId, stockTransferId: created.transfer.id, dispatchedByUserId: userId }));

    const received = await db.transaction((tx) =>
      st.receiveStockTransfer(tx, {
        restaurantId,
        stockTransferId: created.transfer.id,
        receivedByUserId: userId,
        items: [{ stockTransferItemId: created.items[0].id, receivedQuantityMilliunits: 0, note: "TEST entire box lost" }],
      }),
    );
    expect(received.receivedLineCount).toBe(0);

    const movements = await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.referenceId, created.transfer.id));
    expect(movements.filter((m) => m.type === "transfer_in")).toHaveLength(0);
    expect(movements.filter((m) => m.type === "transfer_out")).toHaveLength(1); // dispatch still happened
  });

  it("cancel: a requested (never-dispatched) transfer cancels cleanly with no stock movement", async () => {
    const itemId = await createItem();
    const created = await st.createStockTransfer({
      restaurantId,
      fromBranchId: branchAId,
      toBranchId: branchBId,
      requestedByUserId: userId,
      items: [{ inventoryItemId: itemId, quantityMilliunits: 500 }],
    });

    const cancelled = await db.transaction((tx) =>
      st.cancelStockTransfer(tx, { restaurantId, stockTransferId: created.transfer.id, cancelledByUserId: userId, reason: "TEST no longer needed" }),
    );
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancellationReason).toBe("TEST no longer needed");

    const movements = await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.referenceId, created.transfer.id));
    expect(movements).toHaveLength(0);
  });

  it("cancel is rejected once a transfer has been dispatched — must be received instead", async () => {
    const itemId = await createItem();
    await setSystemStock(itemId, branchAId, 1_000);
    const created = await st.createStockTransfer({
      restaurantId,
      fromBranchId: branchAId,
      toBranchId: branchBId,
      requestedByUserId: userId,
      items: [{ inventoryItemId: itemId, quantityMilliunits: 500 }],
    });
    await db.transaction((tx) => st.approveStockTransfer(tx, { restaurantId, stockTransferId: created.transfer.id, approvedByUserId: userId }));
    await db.transaction((tx) => st.dispatchStockTransfer(tx, { restaurantId, stockTransferId: created.transfer.id, dispatchedByUserId: userId }));

    await expect(
      db.transaction((tx) => st.cancelStockTransfer(tx, { restaurantId, stockTransferId: created.transfer.id, cancelledByUserId: userId, reason: "TEST too late" })),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("state machine validation: dispatch before approval, and receive before dispatch, are both rejected", async () => {
    const itemId = await createItem();
    const created = await st.createStockTransfer({
      restaurantId,
      fromBranchId: branchAId,
      toBranchId: branchBId,
      requestedByUserId: userId,
      items: [{ inventoryItemId: itemId, quantityMilliunits: 500 }],
    });

    await expect(
      db.transaction((tx) => st.dispatchStockTransfer(tx, { restaurantId, stockTransferId: created.transfer.id, dispatchedByUserId: userId })),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      db.transaction((tx) => st.receiveStockTransfer(tx, { restaurantId, stockTransferId: created.transfer.id, receivedByUserId: userId })),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("validation failure: same branch on both sides, empty item list, and duplicate items in one request are all rejected", async () => {
    const itemId = await createItem();
    await expect(
      st.createStockTransfer({
        restaurantId,
        fromBranchId: branchAId,
        toBranchId: branchAId,
        requestedByUserId: userId,
        items: [{ inventoryItemId: itemId, quantityMilliunits: 500 }],
      }),
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      st.createStockTransfer({ restaurantId, fromBranchId: branchAId, toBranchId: branchBId, requestedByUserId: userId, items: [] }),
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      st.createStockTransfer({
        restaurantId,
        fromBranchId: branchAId,
        toBranchId: branchBId,
        requestedByUserId: userId,
        items: [
          { inventoryItemId: itemId, quantityMilliunits: 500 },
          { inventoryItemId: itemId, quantityMilliunits: 200 },
        ],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("wrong-restaurant isolation: a transfer belonging to another restaurant is not visible/actionable from this one", async () => {
    const otherItem = await db
      .insert(schema.inventoryItems)
      .values({ restaurantId: otherRestaurantId, name: "TEST Other Item", unit: "kg", costPerUnitInPaisa: 100 })
      .returning({ id: schema.inventoryItems.id });
    const [otherBranchB] = await db
      .insert(schema.branches)
      .values({ restaurantId: otherRestaurantId, name: "Other B", isMain: false })
      .returning({ id: schema.branches.id });

    const otherTransfer = await st.createStockTransfer({
      restaurantId: otherRestaurantId,
      fromBranchId: otherRestaurantBranchId,
      toBranchId: otherBranchB.id,
      requestedByUserId: userId,
      items: [{ inventoryItemId: otherItem[0].id, quantityMilliunits: 100 }],
    });

    await expect(st.getStockTransferDetail(restaurantId, otherTransfer.transfer.id)).rejects.toMatchObject({ status: 404 });
    await expect(
      db.transaction((tx) => st.approveStockTransfer(tx, { restaurantId, stockTransferId: otherTransfer.transfer.id, approvedByUserId: userId })),
    ).rejects.toMatchObject({ status: 404 });

    const ownDetail = await st.getStockTransferDetail(otherRestaurantId, otherTransfer.transfer.id);
    expect(ownDetail.transfer.id).toBe(otherTransfer.transfer.id);
  });

  it("wrong-branch: listStockTransfers scoped to one branch includes transfers both FROM and TO it, and excludes transfers touching neither", async () => {
    const itemId = await createItem();
    const aToB = await st.createStockTransfer({ restaurantId, fromBranchId: branchAId, toBranchId: branchBId, requestedByUserId: userId, items: [{ inventoryItemId: itemId, quantityMilliunits: 100 }] });
    const bToC = await st.createStockTransfer({ restaurantId, fromBranchId: branchBId, toBranchId: branchCId, requestedByUserId: userId, items: [{ inventoryItemId: await createItem(), quantityMilliunits: 50 }] });
    const aToC = await st.createStockTransfer({ restaurantId, fromBranchId: branchAId, toBranchId: branchCId, requestedByUserId: userId, items: [{ inventoryItemId: await createItem(), quantityMilliunits: 20 }] });

    const branchBList = await st.listStockTransfers(restaurantId, { branchId: branchBId });
    const branchBIds = branchBList.map((t) => t.id);
    expect(branchBIds).toContain(aToB.transfer.id);
    expect(branchBIds).toContain(bToC.transfer.id);
    expect(branchBIds).not.toContain(aToC.transfer.id);
  });

  it("duplicate/concurrent request: two concurrent approveStockTransfer calls on the same transfer — exactly one succeeds", async () => {
    const itemId = await createItem();
    const created = await st.createStockTransfer({ restaurantId, fromBranchId: branchAId, toBranchId: branchBId, requestedByUserId: userId, items: [{ inventoryItemId: itemId, quantityMilliunits: 100 }] });

    const attempt = () =>
      db
        .transaction((tx) => st.approveStockTransfer(tx, { restaurantId, stockTransferId: created.transfer.id, approvedByUserId: userId }))
        .then((r) => ({ ok: true as const, r }))
        .catch((err) => ({ ok: false as const, err }));

    const [a, b] = await Promise.all([attempt(), attempt()]);
    const outcomes = [a, b];
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(outcomes.filter((o) => !o.ok)).toHaveLength(1);
  });

  it("rollback on failure: creating a transfer with an unknown inventory item creates nothing at all (no orphaned header row)", async () => {
    const before = await st.listStockTransfers(restaurantId, {});
    await expect(
      st.createStockTransfer({
        restaurantId,
        fromBranchId: branchAId,
        toBranchId: branchBId,
        requestedByUserId: userId,
        items: [{ inventoryItemId: "00000000-0000-0000-0000-000000000000", quantityMilliunits: 100 }],
      }),
    ).rejects.toMatchObject({ status: 404 });
    const after = await st.listStockTransfers(restaurantId, {});
    expect(after).toHaveLength(before.length);
  });

  it("QA hardening (Phase 7) — receiveStockTransfer rejects a received quantity exceeding what was dispatched, and rejects negative received quantities, with no stock movement or status change on either rejection", async () => {
    const itemId = await createItem();
    await setSystemStock(itemId, branchAId, 5_000);
    const created = await st.createStockTransfer({
      restaurantId,
      fromBranchId: branchAId,
      toBranchId: branchBId,
      requestedByUserId: userId,
      items: [{ inventoryItemId: itemId, quantityMilliunits: 2_000 }],
    });
    await db.transaction((tx) => st.approveStockTransfer(tx, { restaurantId, stockTransferId: created.transfer.id, approvedByUserId: userId }));
    await db.transaction((tx) => st.dispatchStockTransfer(tx, { restaurantId, stockTransferId: created.transfer.id, dispatchedByUserId: userId }));

    // Over-dispatched: dispatched 2_000, trying to receive 2_001.
    await expect(
      db.transaction((tx) =>
        st.receiveStockTransfer(tx, {
          restaurantId,
          stockTransferId: created.transfer.id,
          receivedByUserId: userId,
          items: [{ stockTransferItemId: created.items[0].id, receivedQuantityMilliunits: 2_001 }],
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });

    // Negative received quantity — pre-existing check, still holds.
    await expect(
      db.transaction((tx) =>
        st.receiveStockTransfer(tx, {
          restaurantId,
          stockTransferId: created.transfer.id,
          receivedByUserId: userId,
          items: [{ stockTransferItemId: created.items[0].id, receivedQuantityMilliunits: -1 }],
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });

    // Neither rejected attempt touched anything — the transfer is still
    // "dispatched" (not "received"), the line's receivedQuantityMilliunits
    // is still unset, and no "transfer_in" movement (which would credit
    // stock that was never actually sent) was ever written.
    const [transfer] = await db.select().from(schema.stockTransfers).where(eq(schema.stockTransfers.id, created.transfer.id));
    expect(transfer.status).toBe("dispatched");
    const [line] = await db.select().from(schema.stockTransferItems).where(eq(schema.stockTransferItems.id, created.items[0].id));
    expect(line.receivedQuantityMilliunits).toBeNull();
    const movements = await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.referenceId, created.transfer.id));
    expect(movements.filter((m) => m.type === "transfer_in")).toHaveLength(0);

    // Receiving EXACTLY what was dispatched (the boundary) still succeeds.
    const received = await db.transaction((tx) =>
      st.receiveStockTransfer(tx, {
        restaurantId,
        stockTransferId: created.transfer.id,
        receivedByUserId: userId,
        items: [{ stockTransferItemId: created.items[0].id, receivedQuantityMilliunits: 2_000 }],
      }),
    );
    expect(received.transfer.status).toBe("received");
  });

  it("QA hardening (Phase 7) — two concurrent receiveStockTransfer calls on the same transfer: exactly one succeeds, only one set of transfer_in movements is ever written", async () => {
    const itemId = await createItem();
    await setSystemStock(itemId, branchAId, 3_000);
    const created = await st.createStockTransfer({
      restaurantId,
      fromBranchId: branchAId,
      toBranchId: branchBId,
      requestedByUserId: userId,
      items: [{ inventoryItemId: itemId, quantityMilliunits: 1_000 }],
    });
    await db.transaction((tx) => st.approveStockTransfer(tx, { restaurantId, stockTransferId: created.transfer.id, approvedByUserId: userId }));
    await db.transaction((tx) => st.dispatchStockTransfer(tx, { restaurantId, stockTransferId: created.transfer.id, dispatchedByUserId: userId }));

    const attempt = () =>
      db
        .transaction((tx) => st.receiveStockTransfer(tx, { restaurantId, stockTransferId: created.transfer.id, receivedByUserId: userId }))
        .then((r) => ({ ok: true as const, r }))
        .catch((err) => ({ ok: false as const, err }));

    const outcomes = await Promise.all([attempt(), attempt()]);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(outcomes.filter((o) => !o.ok)).toHaveLength(1);

    const movements = await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.referenceId, created.transfer.id));
    expect(movements.filter((m) => m.type === "transfer_in")).toHaveLength(1);
  });

  it("edge case: dispatch/receive still succeed even when the source branch's stock goes negative (no blocking on insufficient stock, same convention as the rest of the app)", async () => {
    const itemId = await createItem();
    await setSystemStock(itemId, branchAId, 100); // only 0.1kg on hand
    const created = await st.createStockTransfer({ restaurantId, fromBranchId: branchAId, toBranchId: branchBId, requestedByUserId: userId, items: [{ inventoryItemId: itemId, quantityMilliunits: 5_000 }] }); // request 5kg anyway
    await db.transaction((tx) => st.approveStockTransfer(tx, { restaurantId, stockTransferId: created.transfer.id, approvedByUserId: userId }));
    const dispatched = await db.transaction((tx) => st.dispatchStockTransfer(tx, { restaurantId, stockTransferId: created.transfer.id, dispatchedByUserId: userId }));
    expect(dispatched.transfer.status).toBe("dispatched");

    const [fromLevel] = await db
      .select({ qty: schema.branchInventoryLevels.currentStockMilliunits })
      .from(schema.branchInventoryLevels)
      .where(and(eq(schema.branchInventoryLevels.branchId, branchAId), eq(schema.branchInventoryLevels.inventoryItemId, itemId)));
    expect(fromLevel.qty).toBe(100 - 5_000);
  });
});
