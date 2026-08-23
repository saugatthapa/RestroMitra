/**
 * Integration test for the P0-5 fix: applyPurchaseCosting() (src/lib/
 * inventory.ts) recomputes an inventory item's weighted-average
 * costPerUnitInPaisa by SELECTing the current row, computing the new
 * average in JS, then UPDATEing it. Under Postgres's default READ
 * COMMITTED isolation, a bare `db.transaction()` does NOT protect a
 * read-modify-write like that — a plain SELECT takes no row lock — so two
 * concurrent purchases of the same item could both read the same
 * pre-purchase cost/stock, each independently compute its own "correct"
 * weighted average from that now-stale snapshot, and whichever UPDATE
 * committed second would silently overwrite the first: a lost update where
 * one purchase's price contribution vanishes from the item's cost basis
 * with no trace (stock QUANTITY was always safe here — recordStockMovement
 * does its `+= delta` entirely inside the SQL SET clause — only the cost
 * calculation was vulnerable).
 *
 * The fix adds `.for("update")` to the initial SELECT, so a second
 * concurrent purchase's SELECT blocks until the first transaction commits,
 * then reads the already-updated row instead of a stale one.
 *
 * Mirrors ledger-settlement-race.test.ts's methodology: first proves the
 * fix deterministically via a controlled interleaving (transaction A is
 * held open by a gate until transaction B — a real applyPurchaseCosting
 * call — has fully committed, then A's own SELECT FOR UPDATE proceeds and
 * must see B's committed state, not a stale one), then confirms the same
 * invariant holds under genuine Promise.all concurrency.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("applyPurchaseCosting row locking (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let inventoryLib: typeof import("@/lib/inventory");

  let restaurantId: string;
  let branchId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    inventoryLib = await import("@/lib/inventory");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-inv-cost-race-${suffix}`, name: "TEST Inventory Cost Race Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "TEST Main Branch", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;
  });

  afterAll(async () => {
    await db.delete(schema.stockMovements).where(eq(schema.stockMovements.restaurantId, restaurantId));
    await db.delete(schema.purchases).where(eq(schema.purchases.restaurantId, restaurantId));
    await db.delete(schema.inventoryItems).where(eq(schema.inventoryItems.restaurantId, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  async function createItem(initialStockMilliunits: number, initialCostInPaisa: number) {
    const [item] = await db
      .insert(schema.inventoryItems)
      .values({
        restaurantId,
        name: "TEST Race Item",
        unit: "kg",
        currentStockMilliunits: initialStockMilliunits,
        costPerUnitInPaisa: initialCostInPaisa,
      })
      .returning({ id: schema.inventoryItems.id });
    return item.id;
  }

  async function createPurchase() {
    const [purchase] = await db
      .insert(schema.purchases)
      .values({ restaurantId, branchId, totalInPaisa: 0 })
      .returning({ id: schema.purchases.id });
    return purchase.id;
  }

  it("a deliberately-interleaved stale reader is blocked until a real applyPurchaseCosting call commits, then sees its result", async () => {
    // Start: 1000 milliunits (1 unit) on hand at 10000 paisa/unit.
    const itemId = await createItem(1000, 10_000);
    const purchaseIdA = await createPurchase();
    const purchaseIdB = await createPurchase();

    let resolveBStarted!: () => void;
    const bStarted = new Promise<void>((resolve) => {
      resolveBStarted = resolve;
    });

    // Transaction A: takes the row lock first, then waits on a gate before
    // releasing it (simulating "A is mid-transaction, hasn't committed
    // yet") — this holds the lock so B's SELECT FOR UPDATE must block.
    let releaseA!: () => void;
    const aCanProceed = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const aPromise = db.transaction(async (tx) => {
      await inventoryLib.applyPurchaseCosting(tx, {
        restaurantId,
        branchId,
        inventoryItemId: itemId,
        purchasedQuantityMilliunits: 1000, // +1 unit at 20000/unit
        unitCostInPaisa: 20_000,
        purchaseId: purchaseIdA,
      });
      resolveBStarted();
      await aCanProceed; // hold the transaction (and its row lock) open
    });

    // Give A a moment to actually acquire the lock inside its transaction
    // before B tries to start — applyPurchaseCosting's own SELECT FOR
    // UPDATE + UPDATE both happen before resolveBStarted() fires above.
    await bStarted;

    // B starts and should block on SELECT FOR UPDATE until A commits.
    let bResolved = false;
    const bPromise = db
      .transaction((tx) =>
        inventoryLib.applyPurchaseCosting(tx, {
          restaurantId,
          branchId,
          inventoryItemId: itemId,
          purchasedQuantityMilliunits: 1000, // +1 unit at 30000/unit
          unitCostInPaisa: 30_000,
          purchaseId: purchaseIdB,
        }),
      )
      .then((r) => {
        bResolved = true;
        return r;
      });

    // Give B a beat to attempt (and block on) its SELECT FOR UPDATE.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(bResolved).toBe(false); // still blocked behind A's uncommitted lock

    releaseA();
    await aPromise;
    await bPromise;

    // A: stock 1000 -> 2000 at (1000*10000 + 1000*20000)/2000 = 15000
    // B must see A's COMMITTED 2000/15000, not the pre-A 1000/10000 it
    // would have read had its SELECT not blocked — a lost update would
    // instead average B's purchase against the stale 1000/10000 snapshot.
    // B: stock 2000 -> 3000 at (2000*15000 + 1000*30000)/3000 = 20000
    const [final] = await db.select().from(schema.inventoryItems).where(eq(schema.inventoryItems.id, itemId));
    expect(final.currentStockMilliunits).toBe(3000);
    expect(final.costPerUnitInPaisa).toBe(20_000);
  });

  it("under genuine concurrency, both purchases' cost contributions are reflected — no lost update", async () => {
    // Start: 0 on hand, cost irrelevant until first purchase lands.
    const itemId = await createItem(0, 0);
    const purchaseIdA = await createPurchase();
    const purchaseIdB = await createPurchase();

    const attempt = (purchaseId: string, unitCostInPaisa: number) =>
      db.transaction((tx) =>
        inventoryLib.applyPurchaseCosting(tx, {
          restaurantId,
          branchId,
          inventoryItemId: itemId,
          purchasedQuantityMilliunits: 1000, // +1 unit each
          unitCostInPaisa,
          purchaseId,
        }),
      );

    await Promise.all([attempt(purchaseIdA, 10_000), attempt(purchaseIdB, 20_000)]);

    const [final] = await db.select().from(schema.inventoryItems).where(eq(schema.inventoryItems.id, itemId));
    // Total stock must reflect BOTH purchases (this was already safe pre-fix).
    expect(final.currentStockMilliunits).toBe(2000);
    // The final cost must be the weighted average of BOTH purchases,
    // regardless of which order they serialized in: 1 unit @ 10000 + 1
    // unit @ 20000, over 2 units = 15000. A lost update would instead
    // leave the cost at whichever purchase's price landed alone (10000 or
    // 20000), silently dropping the other's contribution.
    expect(final.costPerUnitInPaisa).toBe(15_000);
  });
});
