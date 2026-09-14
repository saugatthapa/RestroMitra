/**
 * Phase 6, Slice 6b — integration coverage for recordTaxRateChange/
 * getTaxRateHistory (src/lib/accounting/tax-rate-history.ts): the
 * effective-dated tax rate audit trail LAYERED ON TOP of
 * menuItems.taxRateBasisPoints (per sign-off), never replacing it.
 *
 * The property that matters most here — and the one a naive
 * implementation gets wrong — is the backdated-correction case: inserting
 * a rate change for a PAST date that falls BEFORE an already-recorded,
 * still-current later date must NOT override the live cache with the
 * older value. The live cache always reflects whichever recorded row has
 * the most recent effectiveFrom that is still <= today.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as every other
 * DB-backed integration test in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("recordTaxRateChange / getTaxRateHistory (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let taxRateHistoryLib: typeof import("@/lib/accounting/tax-rate-history");

  let restaurantId: string;
  let userId: string;
  let categoryId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    taxRateHistoryLib = await import("@/lib/accounting/tax-rate-history");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-tax-rate-history-${suffix}`, name: "TEST Tax Rate History Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [user] = await db
      .insert(schema.users)
      .values({
        fullName: "TEST Tax Rate Editor",
        phone: `9705${suffix.slice(0, 6)}`,
        passwordHash: "test-hash-not-used",
      })
      .returning({ id: schema.users.id });
    userId = user.id;

    const [category] = await db
      .insert(schema.categories)
      .values({ restaurantId, name: "TEST Category" })
      .returning({ id: schema.categories.id });
    categoryId = category.id;
  });

  afterAll(async () => {
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  async function makeMenuItem(taxRateBasisPoints = 0) {
    const [item] = await db
      .insert(schema.menuItems)
      .values({
        restaurantId,
        categoryId,
        name: `TEST Item ${Math.random().toString(36).slice(2, 8)}`,
        basePriceInPaisa: 100_00,
        taxRateBasisPoints,
      })
      .returning();
    return item;
  }

  async function liveRate(menuItemId: string): Promise<number> {
    const [row] = await db
      .select({ taxRateBasisPoints: schema.menuItems.taxRateBasisPoints })
      .from(schema.menuItems)
      .where(eq(schema.menuItems.id, menuItemId));
    return row.taxRateBasisPoints;
  }

  it("records the item's first rate and syncs the live cache to it", async () => {
    const item = await makeMenuItem(0);

    await db.transaction((tx) =>
      taxRateHistoryLib.recordTaxRateChange(tx, {
        restaurantId,
        menuItemId: item.id,
        taxRateBasisPoints: 1300,
        effectiveFrom: "2026-01-01",
        asOfDate: "2026-12-31",
        createdByUserId: userId,
      }),
    );

    expect(await liveRate(item.id)).toBe(1300);

    const history = await db.transaction((tx) => taxRateHistoryLib.getTaxRateHistory(tx, { menuItemId: item.id }));
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ taxRateBasisPoints: 1300, effectiveFrom: "2026-01-01" });
  });

  it("a later effective-dated change becomes the new live rate", async () => {
    const item = await makeMenuItem(0);

    await db.transaction((tx) =>
      taxRateHistoryLib.recordTaxRateChange(tx, {
        restaurantId,
        menuItemId: item.id,
        taxRateBasisPoints: 1300,
        effectiveFrom: "2026-01-01",
        asOfDate: "2026-12-31",
        createdByUserId: userId,
      }),
    );
    await db.transaction((tx) =>
      taxRateHistoryLib.recordTaxRateChange(tx, {
        restaurantId,
        menuItemId: item.id,
        taxRateBasisPoints: 1500,
        effectiveFrom: "2026-03-01",
        asOfDate: "2026-12-31",
        createdByUserId: userId,
      }),
    );

    expect(await liveRate(item.id)).toBe(1500);
  });

  it("a BACKDATED correction between two existing dates does NOT override the still-current later rate", async () => {
    const item = await makeMenuItem(0);

    // Jan 1: 13%, Mar 1: 15% — Mar 1 is the current rate.
    await db.transaction((tx) =>
      taxRateHistoryLib.recordTaxRateChange(tx, {
        restaurantId,
        menuItemId: item.id,
        taxRateBasisPoints: 1300,
        effectiveFrom: "2026-01-01",
        asOfDate: "2026-12-31",
        createdByUserId: userId,
      }),
    );
    await db.transaction((tx) =>
      taxRateHistoryLib.recordTaxRateChange(tx, {
        restaurantId,
        menuItemId: item.id,
        taxRateBasisPoints: 1500,
        effectiveFrom: "2026-03-01",
        asOfDate: "2026-12-31",
        createdByUserId: userId,
      }),
    );
    expect(await liveRate(item.id)).toBe(1500);

    // Backdated correction: "actually Feb 1 was 14%" — a date BEFORE the
    // still-current Mar 1 row. The live cache must stay 1500, not drop to
    // 1400, because Mar 1 is still the most recent date that has passed.
    await db.transaction((tx) =>
      taxRateHistoryLib.recordTaxRateChange(tx, {
        restaurantId,
        menuItemId: item.id,
        taxRateBasisPoints: 1400,
        effectiveFrom: "2026-02-01",
        asOfDate: "2026-12-31",
        createdByUserId: userId,
      }),
    );
    expect(await liveRate(item.id)).toBe(1500);

    const history = await db.transaction((tx) => taxRateHistoryLib.getTaxRateHistory(tx, { menuItemId: item.id }));
    expect(history.map((h) => h.effectiveFrom)).toEqual(["2026-03-01", "2026-02-01", "2026-01-01"]);
  });

  it("rejects a second row for the same item on the same effective date (unique index)", async () => {
    const item = await makeMenuItem(0);

    await db.transaction((tx) =>
      taxRateHistoryLib.recordTaxRateChange(tx, {
        restaurantId,
        menuItemId: item.id,
        taxRateBasisPoints: 1300,
        effectiveFrom: "2026-01-01",
        asOfDate: "2026-12-31",
        createdByUserId: userId,
      }),
    );

    await expect(
      db.transaction((tx) =>
        taxRateHistoryLib.recordTaxRateChange(tx, {
          restaurantId,
          menuItemId: item.id,
          taxRateBasisPoints: 1400,
          effectiveFrom: "2026-01-01",
          asOfDate: "2026-12-31",
          createdByUserId: userId,
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
  });

  it("history is scoped per menu item — a second item's own history stays independent", async () => {
    const itemA = await makeMenuItem(0);
    const itemB = await makeMenuItem(0);

    await db.transaction((tx) =>
      taxRateHistoryLib.recordTaxRateChange(tx, {
        restaurantId,
        menuItemId: itemA.id,
        taxRateBasisPoints: 1300,
        effectiveFrom: "2026-01-01",
        asOfDate: "2026-12-31",
        createdByUserId: userId,
      }),
    );
    await db.transaction((tx) =>
      taxRateHistoryLib.recordTaxRateChange(tx, {
        restaurantId,
        menuItemId: itemB.id,
        taxRateBasisPoints: 500,
        effectiveFrom: "2026-01-01",
        asOfDate: "2026-12-31",
        createdByUserId: userId,
      }),
    );

    expect(await liveRate(itemA.id)).toBe(1300);
    expect(await liveRate(itemB.id)).toBe(500);

    const historyA = await db.transaction((tx) => taxRateHistoryLib.getTaxRateHistory(tx, { menuItemId: itemA.id }));
    expect(historyA).toHaveLength(1);
    expect(historyA[0].taxRateBasisPoints).toBe(1300);
  });

  it("check constraints reject an out-of-range rate at the DB level", async () => {
    const item = await makeMenuItem(0);

    await expect(
      db.insert(schema.menuItemTaxRateHistory).values({
        restaurantId,
        menuItemId: item.id,
        taxRateBasisPoints: 10001,
        effectiveFrom: "2026-01-01",
        createdByUserId: userId,
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });

    await expect(
      db.insert(schema.menuItemTaxRateHistory).values({
        restaurantId,
        menuItemId: item.id,
        taxRateBasisPoints: -1,
        effectiveFrom: "2026-01-01",
        createdByUserId: userId,
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("cascades delete when the menu item is deleted", async () => {
    const item = await makeMenuItem(0);
    await db.transaction((tx) =>
      taxRateHistoryLib.recordTaxRateChange(tx, {
        restaurantId,
        menuItemId: item.id,
        taxRateBasisPoints: 1300,
        effectiveFrom: "2026-01-01",
        asOfDate: "2026-12-31",
        createdByUserId: userId,
      }),
    );

    await db.delete(schema.menuItems).where(eq(schema.menuItems.id, item.id));

    const remaining = await db
      .select()
      .from(schema.menuItemTaxRateHistory)
      .where(
        and(
          eq(schema.menuItemTaxRateHistory.menuItemId, item.id),
          eq(schema.menuItemTaxRateHistory.restaurantId, restaurantId),
        ),
      );
    expect(remaining).toHaveLength(0);
  });
});
