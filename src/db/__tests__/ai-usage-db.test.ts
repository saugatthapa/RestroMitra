/**
 * Platform Control Center, Phase 7 — integration test for the AI usage
 * ledger (src/lib/ai/usage-db.ts). Skipped (not failed) when DATABASE_URL
 * isn't set, same convention as plans-db.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import crypto from "node:crypto";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("usage-db (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let usageDb: typeof import("@/lib/ai/usage-db");

  let restaurantAId: string;
  let restaurantBId: string;
  const suffix = Math.random().toString(36).slice(2, 8);

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    usageDb = await import("@/lib/ai/usage-db");

    const [a, b] = await db
      .insert(schema.restaurants)
      .values([
        { slug: `test-usage-a-${suffix}`, name: "TEST Usage Restaurant A", subscriptionStatus: "active", isActive: true },
        { slug: `test-usage-b-${suffix}`, name: "TEST Usage Restaurant B", subscriptionStatus: "active", isActive: true },
      ])
      .returning({ id: schema.restaurants.id });
    restaurantAId = a.id;
    restaurantBId = b.id;

    // A: 2 successful, 1 failed this month.
    await usageDb.recordAiUsage({
      restaurantId: restaurantAId,
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      estimatedCostInPaisa: 0,
      success: true,
    });
    await usageDb.recordAiUsage({
      restaurantId: restaurantAId,
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      promptTokens: 200,
      completionTokens: 100,
      totalTokens: 300,
      estimatedCostInPaisa: 0,
      success: true,
    });
    await usageDb.recordAiUsage({
      restaurantId: restaurantAId,
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      estimatedCostInPaisa: null,
      success: false,
      errorMessage: "rate limited",
    });

    // B: 1 successful with a real cost figure, for the platform summary's
    // cost-descending ordering.
    await usageDb.recordAiUsage({
      restaurantId: restaurantBId,
      provider: "anthropic",
      model: "claude-3-5-haiku-latest",
      promptTokens: 1000,
      completionTokens: 500,
      totalTokens: 1500,
      estimatedCostInPaisa: 500,
      success: true,
    });
  });

  afterAll(async () => {
    await db.delete(schema.aiUsageLogs).where(eq(schema.aiUsageLogs.restaurantId, restaurantAId));
    await db.delete(schema.aiUsageLogs).where(eq(schema.aiUsageLogs.restaurantId, restaurantBId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantAId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantBId));
  });

  it("countAiRequestsThisMonth counts only successful attempts", async () => {
    expect(await usageDb.countAiRequestsThisMonth(restaurantAId)).toBe(2);
  });

  it("countAiRequestsThisMonth is 0 for a restaurant with no usage", async () => {
    expect(await usageDb.countAiRequestsThisMonth(crypto.randomUUID())).toBe(0);
  });

  it("getAiUsageSummaryForRestaurant totals attempts, tokens, and cost, splitting success/failure", async () => {
    const summary = await usageDb.getAiUsageSummaryForRestaurant(restaurantAId);
    expect(summary.totalAttempts).toBe(3);
    expect(summary.successfulAttempts).toBe(2);
    expect(summary.failedAttempts).toBe(1);
    expect(summary.totalPromptTokens).toBe(300);
    expect(summary.totalCompletionTokens).toBe(150);
    expect(summary.totalEstimatedCostInPaisa).toBe(0);
  });

  it("getPlatformAiUsageSummary includes both restaurants, ordered by estimated cost descending", async () => {
    const rows = await usageDb.getPlatformAiUsageSummary();
    const aRow = rows.find((r) => r.restaurantId === restaurantAId);
    const bRow = rows.find((r) => r.restaurantId === restaurantBId);
    expect(aRow).toBeDefined();
    expect(bRow).toBeDefined();
    expect(bRow?.totalEstimatedCostInPaisa).toBe(500);
    expect(aRow?.totalAttempts).toBe(3);
    // B's higher cost should sort ahead of A's (0-cost) rows.
    const bIndex = rows.findIndex((r) => r.restaurantId === restaurantBId);
    const aIndex = rows.findIndex((r) => r.restaurantId === restaurantAId);
    expect(bIndex).toBeLessThan(aIndex);
  });

  it("getRecentAiUsageEvents surfaces both restaurants' events, newest first", async () => {
    const events = await usageDb.getRecentAiUsageEvents(100);
    const restaurantIds = events.map((e) => e.restaurantId);
    expect(restaurantIds).toContain(restaurantAId);
    expect(restaurantIds).toContain(restaurantBId);
    const failedEvent = events.find((e) => e.restaurantId === restaurantAId && !e.success);
    expect(failedEvent?.errorMessage).toBe("rate limited");
  });
});
