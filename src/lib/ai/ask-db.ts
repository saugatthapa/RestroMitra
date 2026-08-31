import "server-only";
import { db } from "@/db";
import { restaurants } from "@/db/schema";
import { eq } from "drizzle-orm";
import { hasFeature } from "@/lib/entitlements-db";
import { FEATURES } from "@/lib/feature-catalog";
import { aiMonthlyRequestLimitForRestaurant } from "@/lib/plans-db";
import { askAssistantWithFailover, AssistantAllProvidersFailedError, type AssistantFailoverResult } from "./assistant";
import { resolveAiProviderChain } from "./provider-config-db";
import { recordAiUsage, countAiRequestsThisMonth } from "./usage-db";
import { estimateCostInPaisa } from "./cost";

/**
 * Platform Control Center (Phase 7) — the single entry point a route
 * should call to actually ask the assistant a question, replacing a direct
 * askAssistant()/askAssistantWithFailover() call. Wires together every
 * piece Phase 7 added: the entitlement gate, the monthly quota, the
 * DB-backed (or env-fallback) provider chain, failover, and the usage
 * ledger — so a route only has to translate the three typed outcomes below
 * into an HTTP response.
 *
 * IMPORTANT BEHAVIOR CHANGE: before this function existed, EVERY restaurant
 * had unrestricted access to the AI assistant regardless of plan — the ask
 * route only ever checked VIEW_REPORTS. This is the first place the
 * assistant is gated behind the `ai_assistant` feature key, so a
 * starter-plan restaurant (which does not carry that key — see
 * drizzle/0056's seed data) now gets AiAssistantNotEntitledError instead of
 * an answer. This is intentional per the Phase 7 scope the user approved
 * ("per-tenant AI usage limits enforced through Phase 5's entitlement
 * engine"), not an oversight — flagged prominently here and in the phase's
 * own commit message/report.
 */

export class AiAssistantNotEntitledError extends Error {
  constructor() {
    super("The AI assistant is not included in this restaurant's plan.");
    this.name = "AiAssistantNotEntitledError";
  }
}

export class AiAssistantQuotaExceededError extends Error {
  constructor(
    public readonly limit: number,
    public readonly used: number,
  ) {
    super(`This restaurant has used its AI assistant quota for this month (${used}/${limit}).`);
    this.name = "AiAssistantQuotaExceededError";
  }
}

/**
 * Re-thrown as-is when every provider in the chain failed — the caller
 * (the ask route) already knows how to render AssistantAllProvidersFailedError
 * into a 502; re-exported here so route code only needs one import.
 */
export { AssistantAllProvidersFailedError };

export async function askAssistantForRestaurant(
  restaurantId: string,
  params: { systemPrompt: string; question: string },
): Promise<AssistantFailoverResult> {
  const entitled = await hasFeature(restaurantId, FEATURES.AI_ASSISTANT);
  if (!entitled) {
    throw new AiAssistantNotEntitledError();
  }

  const [restaurantRow] = await db
    .select({ planKey: restaurants.planKey, aiMonthlyRequestLimitOverride: restaurants.aiMonthlyRequestLimitOverride })
    .from(restaurants)
    .where(eq(restaurants.id, restaurantId))
    .limit(1);

  const limit = await aiMonthlyRequestLimitForRestaurant({
    planKey: restaurantRow?.planKey ?? null,
    aiMonthlyRequestLimitOverride: restaurantRow?.aiMonthlyRequestLimitOverride ?? null,
  });

  if (limit !== null) {
    const used = await countAiRequestsThisMonth(restaurantId);
    if (used >= limit) {
      throw new AiAssistantQuotaExceededError(limit, used);
    }
  }

  const chain = await resolveAiProviderChain();
  const startedAt = Date.now();

  try {
    const result = await askAssistantWithFailover(params, chain);

    // Log every failed attempt that preceded the eventual success, plus
    // the success itself — see usage-db.ts's own comment on why
    // countAiRequestsThisMonth only counts success:true rows.
    await Promise.all([
      ...result.failedAttempts.map((attempt) =>
        recordAiUsage({
          restaurantId,
          provider: attempt.provider,
          model: attempt.model,
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
          estimatedCostInPaisa: null,
          success: false,
          errorMessage: attempt.error instanceof Error ? attempt.error.message : String(attempt.error),
        }),
      ),
      recordAiUsage({
        restaurantId,
        provider: result.provider,
        model: result.model,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        totalTokens: result.usage.totalTokens,
        estimatedCostInPaisa: estimateCostInPaisa(
          result.provider,
          result.model,
          result.usage.promptTokens,
          result.usage.completionTokens,
        ),
        success: true,
        latencyMs: Date.now() - startedAt,
      }),
    ]);

    return result;
  } catch (err) {
    if (err instanceof AssistantAllProvidersFailedError) {
      await Promise.all(
        err.attempts.map((attempt) =>
          recordAiUsage({
            restaurantId,
            provider: attempt.provider,
            model: attempt.model,
            promptTokens: null,
            completionTokens: null,
            totalTokens: null,
            estimatedCostInPaisa: null,
            success: false,
            errorMessage: attempt.error instanceof Error ? attempt.error.message : String(attempt.error),
          }),
        ),
      );
    }
    throw err;
  }
}
