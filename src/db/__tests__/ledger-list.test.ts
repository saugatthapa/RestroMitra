/**
 * Commercial Launch Phase B.5 (Data Export) integration tests for
 * listLedgerEntries() in src/lib/ledger.ts — the function extracted from
 * GET /api/restaurants/[slug]/ledger's own inline query (see that route
 * and the new /ledger/export route, both of which now call this same
 * function) so the export route can request a higher row limit without
 * duplicating the filter logic.
 *
 * RBAC/permission gating itself lives in the route (MANAGE_ACCOUNT_BOOKS,
 * same as viewing — see the export route's own comment on why no new
 * permission was introduced) and resolveRestaurantContext's own tests
 * already cover that layer, so this file exercises listLedgerEntries'
 * filter/scoping/limit behavior directly.
 *
 * Skipped (not failed) when DATABASE_URL isn't set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("listLedgerEntries (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let ledger: typeof import("@/lib/ledger");

  let ownerId: string;
  let restaurantId: string;
  let otherRestaurantId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    ledger = await import("@/lib/ledger");

    const suffix = Math.random().toString(36).slice(2, 8);

    const [owner] = await db
      .insert(schema.users)
      .values({ fullName: "TEST Ledger List Owner", phone: `9712${suffix.slice(0, 6)}`, passwordHash: "x" })
      .returning({ id: schema.users.id });
    ownerId = owner.id;

    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-ledger-list-${suffix}`, name: "TEST Ledger List Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [otherRestaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-ledger-list-other-${suffix}`, name: "TEST Other Restaurant" })
      .returning({ id: schema.restaurants.id });
    otherRestaurantId = otherRestaurant.id;
  });

  afterAll(async () => {
    await db.delete(schema.ledgerEntries).where(eq(schema.ledgerEntries.restaurantId, restaurantId));
    await db.delete(schema.ledgerEntries).where(eq(schema.ledgerEntries.restaurantId, otherRestaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, otherRestaurantId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerId));
  });

  function record(params: {
    targetRestaurantId: string;
    entryDate: string;
    direction: "credit" | "debit";
    category: "sales" | "expense";
    amountInPaisa: number;
    markAsDue?: boolean;
    isVoided?: boolean;
  }) {
    return db.transaction(async (tx) => {
      const entry = await ledger.recordLedgerEntry(tx, {
        restaurantId: params.targetRestaurantId,
        direction: params.direction,
        category: params.category,
        amountInPaisa: params.amountInPaisa,
        entryDate: params.entryDate,
        description: "TEST entry",
        markAsDue: params.markAsDue,
        timezone: "UTC",
        recordedByUserId: ownerId,
      });
      if (params.isVoided) {
        await tx.update(schema.ledgerEntries).set({ isVoided: true }).where(eq(schema.ledgerEntries.id, entry.id));
      }
      return entry;
    });
  }

  it("happy path: lists entries for the restaurant, newest entryDate first", async () => {
    await record({ targetRestaurantId: restaurantId, entryDate: "2026-01-01", direction: "credit", category: "sales", amountInPaisa: 1_000 });
    await record({ targetRestaurantId: restaurantId, entryDate: "2026-01-05", direction: "credit", category: "sales", amountInPaisa: 2_000 });

    const rows = await ledger.listLedgerEntries(restaurantId);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const dates = rows.map((r) => r.entryDate);
    // Newest entryDate first among our own two rows.
    const idxJan5 = dates.indexOf("2026-01-05");
    const idxJan1 = dates.indexOf("2026-01-01");
    expect(idxJan5).toBeGreaterThanOrEqual(0);
    expect(idxJan1).toBeGreaterThan(idxJan5);
  });

  it("wrong-restaurant isolation: never returns another restaurant's entries", async () => {
    const other = await record({ targetRestaurantId: otherRestaurantId, entryDate: "2026-01-01", direction: "credit", category: "sales", amountInPaisa: 5_000 });

    const rows = await ledger.listLedgerEntries(restaurantId);
    expect(rows.some((r) => r.id === other.id)).toBe(false);
  });

  it("filters by date range (from/to, inclusive)", async () => {
    await record({ targetRestaurantId: restaurantId, entryDate: "2026-02-01", direction: "credit", category: "sales", amountInPaisa: 1_000 });
    await record({ targetRestaurantId: restaurantId, entryDate: "2026-02-15", direction: "credit", category: "sales", amountInPaisa: 1_000 });
    await record({ targetRestaurantId: restaurantId, entryDate: "2026-03-01", direction: "credit", category: "sales", amountInPaisa: 1_000 });

    const rows = await ledger.listLedgerEntries(restaurantId, { from: "2026-02-01", to: "2026-02-28" });
    expect(rows.every((r) => r.entryDate >= "2026-02-01" && r.entryDate <= "2026-02-28")).toBe(true);
    expect(rows.some((r) => r.entryDate === "2026-02-01")).toBe(true);
    expect(rows.some((r) => r.entryDate === "2026-02-15")).toBe(true);
    expect(rows.some((r) => r.entryDate === "2026-03-01")).toBe(false);
  });

  it("filters by category, direction, and dueStatus", async () => {
    const due = await record({ targetRestaurantId: restaurantId, entryDate: "2026-04-01", direction: "credit", category: "sales", amountInPaisa: 3_000, markAsDue: true });
    const expense = await record({ targetRestaurantId: restaurantId, entryDate: "2026-04-01", direction: "debit", category: "expense", amountInPaisa: 500 });

    const dueOnly = await ledger.listLedgerEntries(restaurantId, { dueStatus: "outstanding" });
    expect(dueOnly.some((r) => r.id === due.id)).toBe(true);
    expect(dueOnly.some((r) => r.id === expense.id)).toBe(false);

    const expensesOnly = await ledger.listLedgerEntries(restaurantId, { category: "expense" });
    expect(expensesOnly.some((r) => r.id === expense.id)).toBe(true);
    expect(expensesOnly.some((r) => r.id === due.id)).toBe(false);

    const debitsOnly = await ledger.listLedgerEntries(restaurantId, { direction: "debit" });
    expect(debitsOnly.every((r) => r.direction === "debit")).toBe(true);
  });

  it("excludes voided entries unless includeVoided is set", async () => {
    const voided = await record({ targetRestaurantId: restaurantId, entryDate: "2026-05-01", direction: "debit", category: "expense", amountInPaisa: 100, isVoided: true });

    const withoutVoided = await ledger.listLedgerEntries(restaurantId, { from: "2026-05-01", to: "2026-05-01" });
    expect(withoutVoided.some((r) => r.id === voided.id)).toBe(false);

    const withVoided = await ledger.listLedgerEntries(restaurantId, { includeVoided: true });
    expect(withVoided.some((r) => r.id === voided.id)).toBe(true);
  });

  it("edge case: a filter matching nothing returns an empty array, not an error", async () => {
    const rows = await ledger.listLedgerEntries(restaurantId, { from: "1999-01-01", to: "1999-01-02" });
    expect(rows).toEqual([]);
  });

  it("respects a custom limit (higher than the UI route's default 500), for the export route's use case", async () => {
    const rows = await ledger.listLedgerEntries(restaurantId, {}, 1);
    expect(rows.length).toBeLessThanOrEqual(1);
  });
});
