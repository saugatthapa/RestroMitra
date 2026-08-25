/**
 * Commercial Launch Phase B.9 (Split Bill) integration tests for
 * replaceBillSplits/loadBillSplitSummary/computeBillSplitSummary in
 * src/lib/bill-splits.ts.
 *
 * Same convention as table-operations.test.ts/coupons.test.ts (see their
 * own doc comments): RBAC/branch-access scoping for
 * resolveRestaurantContext()/requireBranchAccess() is covered by its own
 * tests, so this file exercises the business logic directly — the
 * allocation math, whole-state-replace semantics, over-assignment
 * rejection, tenant isolation, payment-splitId cross-referencing, and
 * concurrent redefinition.
 *
 * Skipped (not failed) when DATABASE_URL isn't set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Split Bill (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let billSplits: typeof import("@/lib/bill-splits");

  let restaurantId: string;
  let otherRestaurantId: string;
  let branchId: string;
  let otherRestaurantBranchId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    billSplits = await import("@/lib/bill-splits");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-splits-${suffix}`, name: "TEST Split Bill Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [otherRestaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-splits-other-${suffix}`, name: "TEST Other Restaurant" })
      .returning({ id: schema.restaurants.id });
    otherRestaurantId = otherRestaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;

    const [otherBranch] = await db
      .insert(schema.branches)
      .values({ restaurantId: otherRestaurantId, name: "Main", isMain: true })
      .returning({ id: schema.branches.id });
    otherRestaurantBranchId = otherBranch.id;
  });

  afterAll(async () => {
    await db.delete(schema.orders).where(eq(schema.orders.restaurantId, restaurantId));
    await db.delete(schema.orders).where(eq(schema.orders.restaurantId, otherRestaurantId));
    await db.delete(schema.branches).where(eq(schema.branches.restaurantId, restaurantId));
    await db.delete(schema.branches).where(eq(schema.branches.restaurantId, otherRestaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, otherRestaurantId));
  });

  /** Minimal order — no real menu items needed since orderItems are
   * inserted directly below with their own snapshot fields (menuItemId is
   * nullable — traceability only, never read for pricing, see its own
   * schema comment). */
  async function makeOrder(overrides: Partial<typeof schema.orders.$inferInsert> = {}) {
    const [order] = await db
      .insert(schema.orders)
      .values({
        restaurantId,
        branchId,
        orderNumber: `TEST-SPLIT-${Math.random().toString(36).slice(2, 10)}`,
        source: "pos",
        status: "pending",
        subtotalInPaisa: 0,
        taxInPaisa: 0,
        totalInPaisa: 0,
        ...overrides,
      })
      .returning();
    return order;
  }

  async function makeItem(
    orderId: string,
    opts: { name: string; unitPriceInPaisa: number; quantity: number },
  ) {
    const lineTotalInPaisa = opts.unitPriceInPaisa * opts.quantity;
    const [item] = await db
      .insert(schema.orderItems)
      .values({
        orderId,
        menuItemNameSnapshot: opts.name,
        unitPriceInPaisa: opts.unitPriceInPaisa,
        quantity: opts.quantity,
        lineSubtotalInPaisa: lineTotalInPaisa,
        lineTotalInPaisa,
      })
      .returning();
    return item;
  }

  // -------------------------------------------------------------------
  // computeBillSplitSummary — pure allocation math
  // -------------------------------------------------------------------
  describe("computeBillSplitSummary (pure math)", () => {
    it("happy path: two shares split two items exactly, discount/service/tax allocated proportionally", () => {
      // Momo Rs 300 (x1) + Coke Rs 100 (x1) = subtotal 400. 10% discount
      // (40), 10% service charge (40 - wait, on subtotal: 40), tax 8% of
      // (subtotal - discount + service)? This lib allocates discount/
      // service/tax proportionally by line weight, not by re-deriving the
      // order's own formula — so pick round numbers and just verify the
      // invariant: splits total + unassigned total === order.totalInPaisa.
      const order = {
        subtotalInPaisa: 40_000, // Rs 300 + Rs 100
        discountInPaisa: 4_000, // 10%
        serviceChargeInPaisa: 4_000, // 10%
        taxInPaisa: 3_200, // 8% of subtotal, illustrative
        totalInPaisa: 40_000 - 4_000 + 4_000 + 3_200,
      };
      const items = [
        { id: "item-momo", quantity: 1, lineTotalInPaisa: 30_000 },
        { id: "item-coke", quantity: 1, lineTotalInPaisa: 10_000 },
      ];
      const splits = [
        { id: "split-alice", label: "Alice" },
        { id: "split-bob", label: "Bob" },
      ];
      const assignments = [
        { splitId: "split-alice", orderItemId: "item-momo", quantity: 1 },
        { splitId: "split-bob", orderItemId: "item-coke", quantity: 1 },
      ];

      const summary = billSplits.computeBillSplitSummary({
        order,
        items,
        splits,
        assignments,
        payments: [],
      });

      expect(summary.totalInPaisa).toBe(order.totalInPaisa);
      expect(summary.unassigned.itemCount).toBe(0);
      expect(summary.unassigned.subtotalInPaisa).toBe(0);
      const alice = summary.splits.find((s) => s.splitId === "split-alice")!;
      const bob = summary.splits.find((s) => s.splitId === "split-bob")!;
      // Alice's momo is 3/4 of the subtotal weight, Bob's coke is 1/4.
      expect(alice.subtotalInPaisa + bob.subtotalInPaisa).toBe(order.totalInPaisa);
      expect(alice.subtotalInPaisa).toBeGreaterThan(bob.subtotalInPaisa);
    });

    it("edge case: unassigned items are reported separately and still sum exactly to the order total", () => {
      const order = {
        subtotalInPaisa: 20_000,
        discountInPaisa: 0,
        serviceChargeInPaisa: 0,
        taxInPaisa: 0,
        totalInPaisa: 20_000,
      };
      const items = [{ id: "item-a", quantity: 1, lineTotalInPaisa: 20_000 }];
      const summary = billSplits.computeBillSplitSummary({
        order,
        items,
        splits: [{ id: "split-x", label: "X" }],
        assignments: [], // nothing assigned
        payments: [],
      });
      expect(summary.splits[0].subtotalInPaisa).toBe(0);
      expect(summary.unassigned.subtotalInPaisa).toBe(20_000);
      expect(summary.totalInPaisa).toBe(20_000);
    });

    it("edge case: a partial-quantity assignment splits one item row's units exactly with no rounding drift", () => {
      // 3 momos @ Rs 100 = 30,000 paisa. 1 unit to Alice, 2 to Bob.
      const order = {
        subtotalInPaisa: 30_000,
        discountInPaisa: 0,
        serviceChargeInPaisa: 0,
        taxInPaisa: 0,
        totalInPaisa: 30_000,
      };
      const items = [{ id: "item-momo", quantity: 3, lineTotalInPaisa: 30_000 }];
      const summary = billSplits.computeBillSplitSummary({
        order,
        items,
        splits: [
          { id: "split-alice", label: "Alice" },
          { id: "split-bob", label: "Bob" },
        ],
        assignments: [
          { splitId: "split-alice", orderItemId: "item-momo", quantity: 1 },
          { splitId: "split-bob", orderItemId: "item-momo", quantity: 2 },
        ],
        payments: [],
      });
      const alice = summary.splits.find((s) => s.splitId === "split-alice")!;
      const bob = summary.splits.find((s) => s.splitId === "split-bob")!;
      expect(alice.subtotalInPaisa).toBe(10_000);
      expect(bob.subtotalInPaisa).toBe(20_000);
      expect(alice.subtotalInPaisa + bob.subtotalInPaisa).toBe(30_000);
    });

    it("edge case: remainder-to-last-item allocation still sums exactly for an odd, non-dividing discount", () => {
      // Three items of equal weight (1000 each, subtotal 3000) with a
      // discount that doesn't divide evenly by 3 (100) — proves the
      // remainder lands somewhere rather than getting dropped or double-
      // counted.
      const order = {
        subtotalInPaisa: 3_000,
        discountInPaisa: 100,
        serviceChargeInPaisa: 0,
        taxInPaisa: 0,
        totalInPaisa: 2_900,
      };
      const items = [
        { id: "a", quantity: 1, lineTotalInPaisa: 1_000 },
        { id: "b", quantity: 1, lineTotalInPaisa: 1_000 },
        { id: "c", quantity: 1, lineTotalInPaisa: 1_000 },
      ];
      const summary = billSplits.computeBillSplitSummary({
        order,
        items,
        splits: [{ id: "s", label: "Everyone" }],
        assignments: [
          { splitId: "s", orderItemId: "a", quantity: 1 },
          { splitId: "s", orderItemId: "b", quantity: 1 },
          { splitId: "s", orderItemId: "c", quantity: 1 },
        ],
        payments: [],
      });
      expect(summary.splits[0].subtotalInPaisa).toBe(2_900);
      expect(summary.totalInPaisa).toBe(2_900);
    });

    it("happy path: a split's paidInPaisa/remainingDueInPaisa reflect only payments tagged to it", () => {
      const order = {
        subtotalInPaisa: 10_000,
        discountInPaisa: 0,
        serviceChargeInPaisa: 0,
        taxInPaisa: 0,
        totalInPaisa: 10_000,
      };
      const items = [{ id: "item-a", quantity: 1, lineTotalInPaisa: 10_000 }];
      const summary = billSplits.computeBillSplitSummary({
        order,
        items,
        splits: [{ id: "split-a", label: "Alice" }],
        assignments: [{ splitId: "split-a", orderItemId: "item-a", quantity: 1 }],
        payments: [
          { splitId: "split-a", amountInPaisa: 4_000 },
          { splitId: null, amountInPaisa: 5_000 }, // untagged — must not count toward any split
          { splitId: "some-other-split-not-in-this-order", amountInPaisa: 1_000 },
        ],
      });
      expect(summary.splits[0].paidInPaisa).toBe(4_000);
      expect(summary.splits[0].remainingDueInPaisa).toBe(6_000);
    });
  });

  // -------------------------------------------------------------------
  // replaceBillSplits — transactional write
  // -------------------------------------------------------------------

  it("happy path: replaceBillSplits creates shares with their items, readable back via loadBillSplitSummary", async () => {
    const order = await makeOrder({ subtotalInPaisa: 40_000, totalInPaisa: 40_000 });
    const momo = await makeItem(order.id, { name: "Momo", unitPriceInPaisa: 30_000, quantity: 1 });
    const coke = await makeItem(order.id, { name: "Coke", unitPriceInPaisa: 10_000, quantity: 1 });

    const result = await db.transaction((tx) =>
      billSplits.replaceBillSplits(tx, {
        restaurantId,
        orderId: order.id,
        splits: [
          { label: "Alice", items: [{ orderItemId: momo.id, quantity: 1 }] },
          { label: "Bob", items: [{ orderItemId: coke.id, quantity: 1 }] },
        ],
      }),
    );
    expect(result.splits).toHaveLength(2);
    expect(result.splitItems).toHaveLength(2);

    const { splits, summary } = await billSplits.loadBillSplitSummary(db, { restaurantId, orderId: order.id });
    expect(splits).toHaveLength(2);
    const alice = splits.find((s) => s.label === "Alice")!;
    expect(alice.items).toEqual([{ orderItemId: momo.id, quantity: 1 }]);
    expect(summary.totalInPaisa).toBe(40_000);
  });

  it("whole-state-replace: a second call fully replaces the first — old shares and their items are gone", async () => {
    const order = await makeOrder({ subtotalInPaisa: 10_000, totalInPaisa: 10_000 });
    const item = await makeItem(order.id, { name: "Thali", unitPriceInPaisa: 10_000, quantity: 1 });

    await db.transaction((tx) =>
      billSplits.replaceBillSplits(tx, {
        restaurantId,
        orderId: order.id,
        splits: [{ label: "Alice", items: [{ orderItemId: item.id, quantity: 1 }] }],
      }),
    );
    const second = await db.transaction((tx) =>
      billSplits.replaceBillSplits(tx, {
        restaurantId,
        orderId: order.id,
        splits: [{ label: "Bob", items: [] }],
      }),
    );

    expect(second.splits).toHaveLength(1);
    expect(second.splits[0].label).toBe("Bob");
    const remainingSplits = await db
      .select()
      .from(schema.orderBillSplits)
      .where(eq(schema.orderBillSplits.orderId, order.id));
    expect(remainingSplits).toHaveLength(1);
    expect(remainingSplits[0].label).toBe("Bob");
  });

  it("validation failure: an item over-assigned across shares (more units claimed than ordered) is rejected, and nothing is written", async () => {
    const order = await makeOrder({ subtotalInPaisa: 20_000, totalInPaisa: 20_000 });
    const item = await makeItem(order.id, { name: "Momo", unitPriceInPaisa: 10_000, quantity: 2 });

    await expect(
      db.transaction((tx) =>
        billSplits.replaceBillSplits(tx, {
          restaurantId,
          orderId: order.id,
          splits: [
            { label: "Alice", items: [{ orderItemId: item.id, quantity: 2 }] },
            { label: "Bob", items: [{ orderItemId: item.id, quantity: 1 }] }, // 2 + 1 > 2 available
          ],
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });

    const rows = await db.select().from(schema.orderBillSplits).where(eq(schema.orderBillSplits.orderId, order.id));
    expect(rows).toHaveLength(0);
  });

  it("validation failure: an orderItemId that isn't on this order is rejected", async () => {
    const order = await makeOrder({ subtotalInPaisa: 10_000, totalInPaisa: 10_000 });
    const otherOrder = await makeOrder({ subtotalInPaisa: 10_000, totalInPaisa: 10_000 });
    const foreignItem = await makeItem(otherOrder.id, { name: "Not on this order", unitPriceInPaisa: 10_000, quantity: 1 });

    await expect(
      db.transaction((tx) =>
        billSplits.replaceBillSplits(tx, {
          restaurantId,
          orderId: order.id,
          splits: [{ label: "Alice", items: [{ orderItemId: foreignItem.id, quantity: 1 }] }],
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("edge case: splitting a cancelled order's bill is rejected", async () => {
    const order = await makeOrder({ status: "cancelled", subtotalInPaisa: 10_000, totalInPaisa: 10_000 });

    await expect(
      db.transaction((tx) =>
        billSplits.replaceBillSplits(tx, { restaurantId, orderId: order.id, splits: [{ label: "Alice", items: [] }] }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("unauthorized/not-found: redefining splits on a nonexistent order is rejected", async () => {
    await expect(
      db.transaction((tx) =>
        billSplits.replaceBillSplits(tx, {
          restaurantId,
          orderId: "00000000-0000-0000-0000-000000000000",
          splits: [],
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("wrong-restaurant isolation: redefining another restaurant's order splits is rejected", async () => {
    const foreignOrder = await db
      .insert(schema.orders)
      .values({
        restaurantId: otherRestaurantId,
        branchId: otherRestaurantBranchId,
        orderNumber: `TEST-SPLIT-FOREIGN-${Math.random().toString(36).slice(2, 10)}`,
        source: "pos",
        status: "pending",
        subtotalInPaisa: 10_000,
        taxInPaisa: 0,
        totalInPaisa: 10_000,
      })
      .returning()
      .then((rows) => rows[0]);

    await expect(
      db.transaction((tx) =>
        billSplits.replaceBillSplits(tx, { restaurantId, orderId: foreignOrder.id, splits: [{ label: "Alice", items: [] }] }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("edge case: deleting a split (whole-state-replace with it omitted) sets any payment tagged to it back to untagged, not deleted", async () => {
    const order = await makeOrder({ subtotalInPaisa: 10_000, totalInPaisa: 10_000 });
    const item = await makeItem(order.id, { name: "Thali", unitPriceInPaisa: 10_000, quantity: 1 });

    const first = await db.transaction((tx) =>
      billSplits.replaceBillSplits(tx, {
        restaurantId,
        orderId: order.id,
        splits: [{ label: "Alice", items: [{ orderItemId: item.id, quantity: 1 }] }],
      }),
    );
    const [payment] = await db
      .insert(schema.payments)
      .values({
        restaurantId,
        orderId: order.id,
        amountInPaisa: 5_000,
        method: "cash",
        splitId: first.splits[0].id,
      })
      .returning();

    // Redefine splits without Alice at all.
    await db.transaction((tx) =>
      billSplits.replaceBillSplits(tx, { restaurantId, orderId: order.id, splits: [{ label: "Bob", items: [] }] }),
    );

    const [reloaded] = await db.select().from(schema.payments).where(eq(schema.payments.id, payment.id));
    expect(reloaded).toBeDefined();
    expect(reloaded.amountInPaisa).toBe(5_000); // payment survives
    expect(reloaded.splitId).toBeNull(); // but its share tag is gone (FK ON DELETE SET NULL)
  });

  it("concurrent request: two simultaneous replaceBillSplits calls on the same order both succeed and leave one consistent final state", async () => {
    const order = await makeOrder({ subtotalInPaisa: 10_000, totalInPaisa: 10_000 });
    const item = await makeItem(order.id, { name: "Thali", unitPriceInPaisa: 10_000, quantity: 1 });

    const attempt = (label: string) =>
      db
        .transaction((tx) =>
          billSplits.replaceBillSplits(tx, {
            restaurantId,
            orderId: order.id,
            splits: [{ label, items: [{ orderItemId: item.id, quantity: 1 }] }],
          }),
        )
        .then(() => ({ ok: true as const }))
        .catch(() => ({ ok: false as const }));

    const [a, b] = await Promise.all([attempt("Reason A"), attempt("Reason B")]);
    // The FOR UPDATE lock serializes the two — both are expected to
    // succeed (whole-state-replace is idempotent-by-design, not a CAS
    // claim), but the final state must be ONE consistent share, never a
    // mix of both attempts' rows.
    expect([a.ok, b.ok]).toEqual([true, true]);

    const rows = await db.select().from(schema.orderBillSplits).where(eq(schema.orderBillSplits.orderId, order.id));
    expect(rows).toHaveLength(1);
    expect(["Reason A", "Reason B"]).toContain(rows[0].label);
  });

  // -------------------------------------------------------------------
  // assertSplitBelongsToOrder — used by the payments route before
  // tagging a payment with a splitId
  // -------------------------------------------------------------------

  it("happy path: assertSplitBelongsToOrder accepts a split that actually belongs to the order, and a tagged payment's amount is reflected in the split summary", async () => {
    const order = await makeOrder({ subtotalInPaisa: 10_000, totalInPaisa: 10_000 });
    const item = await makeItem(order.id, { name: "Thali", unitPriceInPaisa: 10_000, quantity: 1 });
    const { splits } = await db.transaction((tx) =>
      billSplits.replaceBillSplits(tx, {
        restaurantId,
        orderId: order.id,
        splits: [{ label: "Alice", items: [{ orderItemId: item.id, quantity: 1 }] }],
      }),
    );

    await expect(
      billSplits.assertSplitBelongsToOrder(db, { orderId: order.id, splitId: splits[0].id }),
    ).resolves.toBeUndefined();

    await db.insert(schema.payments).values({
      restaurantId,
      orderId: order.id,
      amountInPaisa: 10_000,
      method: "cash",
      splitId: splits[0].id,
    });
    const { summary } = await billSplits.loadBillSplitSummary(db, { restaurantId, orderId: order.id });
    expect(summary.splits[0].paidInPaisa).toBe(10_000);
    expect(summary.splits[0].remainingDueInPaisa).toBe(0);
  });

  it("validation failure: assertSplitBelongsToOrder rejects a split id from a DIFFERENT order", async () => {
    const orderA = await makeOrder({ subtotalInPaisa: 10_000, totalInPaisa: 10_000 });
    const orderB = await makeOrder({ subtotalInPaisa: 10_000, totalInPaisa: 10_000 });
    const itemA = await makeItem(orderA.id, { name: "Thali", unitPriceInPaisa: 10_000, quantity: 1 });
    const { splits } = await db.transaction((tx) =>
      billSplits.replaceBillSplits(tx, {
        restaurantId,
        orderId: orderA.id,
        splits: [{ label: "Alice", items: [{ orderItemId: itemA.id, quantity: 1 }] }],
      }),
    );

    await expect(
      billSplits.assertSplitBelongsToOrder(db, { orderId: orderB.id, splitId: splits[0].id }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rollback: an over-assignment failure inside replaceBillSplits leaves the order's PREVIOUS splits fully intact", async () => {
    const order = await makeOrder({ subtotalInPaisa: 20_000, totalInPaisa: 20_000 });
    const item = await makeItem(order.id, { name: "Momo", unitPriceInPaisa: 10_000, quantity: 2 });

    await db.transaction((tx) =>
      billSplits.replaceBillSplits(tx, {
        restaurantId,
        orderId: order.id,
        splits: [{ label: "Original", items: [{ orderItemId: item.id, quantity: 2 }] }],
      }),
    );

    await expect(
      db.transaction((tx) =>
        billSplits.replaceBillSplits(tx, {
          restaurantId,
          orderId: order.id,
          splits: [
            { label: "Alice", items: [{ orderItemId: item.id, quantity: 2 }] },
            { label: "Bob", items: [{ orderItemId: item.id, quantity: 1 }] },
          ],
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });

    const rows = await db.select().from(schema.orderBillSplits).where(eq(schema.orderBillSplits.orderId, order.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe("Original");
  });
});
