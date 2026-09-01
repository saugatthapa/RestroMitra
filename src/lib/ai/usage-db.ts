import "server-only";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { aiUsageLogs, restaurants } from "@/db/schema";

/**
 * Platform Control Center (Phase 7) — the AI usage ledger. One row per
 * askAssistantWithFailover() attempt (see src/lib/ai/assistant.ts) —
 * including a failed one, recorded by the DB-backed ask-orchestration
 * function (src/lib/ai/ask-db.ts) for every entry in failedAttempts plus
 * the final outcome. A restaurant's monthly quota (plans.
 * aiMonthlyRequestLimit / aiMonthlyRequestLimitForRestaurant) is checked
 * against successful requests only — see countAiRequestsThisMonth's own
 * comment for why.
 */

export type RecordAiUsageParams = {
  restaurantId: string;
  provider: string;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  estimatedCostInPaisa: number | null;
  success: boolean;
  errorMessage?: string | null;
  latencyMs?: number | null;
};

export async function recordAiUsage(params: RecordAiUsageParams): Promise<void> {
  await db.insert(aiUsageLogs).values({
    restaurantId: params.restaurantId,
    provider: params.provider,
    model: params.model,
    promptTokens: params.promptTokens,
    completionTokens: params.completionTokens,
    totalTokens: params.totalTokens,
    estimatedCostInPaisa: params.estimatedCostInPaisa,
    success: params.success,
    errorMessage: params.errorMessage ?? null,
    latencyMs: params.latencyMs ?? null,
  });
}

/** [monthStart, nextMonthStart) in UTC for "now" — deliberately UTC, not the restaurant's own timezone: a monthly quota resetting on the 1st of the calendar month is a platform-wide billing concept (like Stripe's usage periods), not a per-tenant-local one, and UTC keeps the reset instant unambiguous across every restaurant regardless of its own timezone setting. */
function currentUtcMonthBounds(now: Date = new Date()): { monthStart: Date; nextMonthStart: Date } {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { monthStart, nextMonthStart };
}

/**
 * How many AI assistant requests this restaurant has made so far in the
 * current UTC calendar month — counted as successful attempts only. A
 * provider-side failure (rate limit, outage) that failover already
 * recovers from isn't something the END USER experiences as "a request
 * that used up their quota" — they got their answer — so counting it
 * against the quota would penalize a restaurant for a provider's own
 * instability. Every attempt (success or failure) is still logged via
 * recordAiUsage() for the cost/reliability dashboards; this count is
 * specifically the one enforcement reads.
 */
export async function countAiRequestsThisMonth(restaurantId: string, now: Date = new Date()): Promise<number> {
  const { monthStart, nextMonthStart } = currentUtcMonthBounds(now);
  const [row] = await db
    .select({ count: sql<string>`count(*)` })
    .from(aiUsageLogs)
    .where(
      and(
        eq(aiUsageLogs.restaurantId, restaurantId),
        eq(aiUsageLogs.success, true),
        gte(aiUsageLogs.createdAt, monthStart),
        lt(aiUsageLogs.createdAt, nextMonthStart),
      ),
    );
  return Number(row?.count ?? 0);
}

export type AiUsageSummary = {
  totalAttempts: number;
  successfulAttempts: number;
  failedAttempts: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  /** Sum of estimatedCostInPaisa across attempts that had one — an attempt against an unmapped provider/model pair (estimateCostInPaisa returned null) is simply excluded, not counted as 0. See src/lib/ai/cost.ts. */
  totalEstimatedCostInPaisa: number;
};

/** Usage totals for one restaurant over [from, to) — defaults to the current UTC calendar month, matching countAiRequestsThisMonth's own window, for the restaurant-facing "AI usage this month" display. */
export async function getAiUsageSummaryForRestaurant(
  restaurantId: string,
  range?: { from: Date; to: Date },
): Promise<AiUsageSummary> {
  const { monthStart, nextMonthStart } = currentUtcMonthBounds();
  const from = range?.from ?? monthStart;
  const to = range?.to ?? nextMonthStart;

  const [row] = await db
    .select({
      totalAttempts: sql<string>`count(*)`,
      successfulAttempts: sql<string>`coalesce(sum(case when ${aiUsageLogs.success} then 1 else 0 end), 0)`,
      totalPromptTokens: sql<string>`coalesce(sum(${aiUsageLogs.promptTokens}), 0)`,
      totalCompletionTokens: sql<string>`coalesce(sum(${aiUsageLogs.completionTokens}), 0)`,
      totalEstimatedCostInPaisa: sql<string>`coalesce(sum(${aiUsageLogs.estimatedCostInPaisa}), 0)`,
    })
    .from(aiUsageLogs)
    .where(
      and(
        eq(aiUsageLogs.restaurantId, restaurantId),
        gte(aiUsageLogs.createdAt, from),
        lt(aiUsageLogs.createdAt, to),
      ),
    );

  const totalAttempts = Number(row?.totalAttempts ?? 0);
  const successfulAttempts = Number(row?.successfulAttempts ?? 0);

  return {
    totalAttempts,
    successfulAttempts,
    failedAttempts: totalAttempts - successfulAttempts,
    totalPromptTokens: Number(row?.totalPromptTokens ?? 0),
    totalCompletionTokens: Number(row?.totalCompletionTokens ?? 0),
    totalEstimatedCostInPaisa: Number(row?.totalEstimatedCostInPaisa ?? 0),
  };
}

export type PlatformAiUsageRow = {
  restaurantId: string;
  restaurantName: string;
  totalAttempts: number;
  successfulAttempts: number;
  totalEstimatedCostInPaisa: number;
};

/**
 * Platform-wide usage, broken down per restaurant, for /admin/ai-providers'
 * usage/cost dashboard — "which tenants are actually using this, and
 * roughly what is it costing." Defaults to the current UTC calendar month.
 * Ordered by estimated cost descending so the heaviest users surface
 * first; a tenant with zero usage in the window simply doesn't appear
 * (this is a usage report, not a full tenant roster).
 */
export async function getPlatformAiUsageSummary(range?: {
  from: Date;
  to: Date;
}): Promise<PlatformAiUsageRow[]> {
  const { monthStart, nextMonthStart } = currentUtcMonthBounds();
  const from = range?.from ?? monthStart;
  const to = range?.to ?? nextMonthStart;

  const rows = await db
    .select({
      restaurantId: aiUsageLogs.restaurantId,
      restaurantName: restaurants.name,
      totalAttempts: sql<string>`count(*)`,
      successfulAttempts: sql<string>`coalesce(sum(case when ${aiUsageLogs.success} then 1 else 0 end), 0)`,
      totalEstimatedCostInPaisa: sql<string>`coalesce(sum(${aiUsageLogs.estimatedCostInPaisa}), 0)`,
    })
    .from(aiUsageLogs)
    .innerJoin(restaurants, eq(restaurants.id, aiUsageLogs.restaurantId))
    .where(and(gte(aiUsageLogs.createdAt, from), lt(aiUsageLogs.createdAt, to)))
    .groupBy(aiUsageLogs.restaurantId, restaurants.name)
    .orderBy(desc(sql`coalesce(sum(${aiUsageLogs.estimatedCostInPaisa}), 0)`));

  return rows.map((r) => ({
    restaurantId: r.restaurantId,
    restaurantName: r.restaurantName,
    totalAttempts: Number(r.totalAttempts),
    successfulAttempts: Number(r.successfulAttempts),
    totalEstimatedCostInPaisa: Number(r.totalEstimatedCostInPaisa),
  }));
}

/** Gap-audit P1 fix (Finding 3) — most recent FAILED attempts only, across the whole platform, newest first. Backs the platform admin "recent alerts" list's AI-provider-failure feed; filtered in SQL (not fetched-then-filtered from getRecentAiUsageEvents) so a burst of successful traffic can never push a real failure off the page. */
export async function getRecentAiFailures(limit = 50) {
  return db
    .select({
      id: aiUsageLogs.id,
      restaurantId: aiUsageLogs.restaurantId,
      restaurantName: restaurants.name,
      provider: aiUsageLogs.provider,
      model: aiUsageLogs.model,
      errorMessage: aiUsageLogs.errorMessage,
      latencyMs: aiUsageLogs.latencyMs,
      createdAt: aiUsageLogs.createdAt,
    })
    .from(aiUsageLogs)
    .innerJoin(restaurants, eq(restaurants.id, aiUsageLogs.restaurantId))
    .where(eq(aiUsageLogs.success, false))
    .orderBy(desc(aiUsageLogs.createdAt))
    .limit(limit);
}

/** Most recent attempts (success and failure) across the whole platform — for a simple activity feed on /admin/ai-providers, newest first. */
export async function getRecentAiUsageEvents(limit = 50) {
  return db
    .select({
      id: aiUsageLogs.id,
      restaurantId: aiUsageLogs.restaurantId,
      restaurantName: restaurants.name,
      provider: aiUsageLogs.provider,
      model: aiUsageLogs.model,
      success: aiUsageLogs.success,
      errorMessage: aiUsageLogs.errorMessage,
      totalTokens: aiUsageLogs.totalTokens,
      estimatedCostInPaisa: aiUsageLogs.estimatedCostInPaisa,
      latencyMs: aiUsageLogs.latencyMs,
      createdAt: aiUsageLogs.createdAt,
    })
    .from(aiUsageLogs)
    .innerJoin(restaurants, eq(restaurants.id, aiUsageLogs.restaurantId))
    .orderBy(desc(aiUsageLogs.createdAt))
    .limit(limit);
}
