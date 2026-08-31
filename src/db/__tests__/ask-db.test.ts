/**
 * Platform Control Center, Phase 7 — integration test for the DB-backed
 * ask-orchestration function (src/lib/ai/ask-db.ts): the entitlement gate,
 * the monthly quota gate, and (for the happy path) that a successful call
 * gets recorded in the usage ledger. Skipped (not failed) when
 * DATABASE_URL isn't set, same convention as plans-db.test.ts.
 *
 * The happy-path test stubs global fetch (askAssistantWithFailover's
 * fetchImpl default parameter re-resolves `fetch` at call time, so
 * vi.stubGlobal before calling askAssistantForRestaurant is enough to
 * intercept it) rather than making a real provider call. It also inserts
 * its own DB provider config row under a suffix-namespaced fake provider
 * name (accepted at this layer — only the API route's Zod schema
 * restricts `provider` to "groq"/"anthropic") rather than relying on
 * ai_provider_configs being empty or on the real "groq"/"anthropic" rows:
 * provider-config-db.test.ts (a different file, possibly running
 * concurrently) inserts and deletes rows under those exact literal names,
 * and the table has no per-test isolation otherwise.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("ask-db (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let askDb: typeof import("@/lib/ai/ask-db");
  let usageDb: typeof import("@/lib/ai/usage-db");
  let providerConfigDb: typeof import("@/lib/ai/provider-config-db");

  const suffix = Math.random().toString(36).slice(2, 8);
  const originalKey = process.env.AI_CONFIG_ENCRYPTION_KEY;

  let entitledPlanKey: string;
  let unentitledPlanKey: string;
  let lowLimitPlanKey: string;

  let entitledRestaurantId: string;
  let unentitledRestaurantId: string;
  let quotaExceededRestaurantId: string;

  beforeAll(async () => {
    const crypto = await import("node:crypto");
    process.env.AI_CONFIG_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");

    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    askDb = await import("@/lib/ai/ask-db");
    usageDb = await import("@/lib/ai/usage-db");
    providerConfigDb = await import("@/lib/ai/provider-config-db");

    entitledPlanKey = `test-ask-entitled-${suffix}`;
    unentitledPlanKey = `test-ask-unentitled-${suffix}`;
    lowLimitPlanKey = `test-ask-lowlimit-${suffix}`;

    await db.insert(schema.plans).values([
      {
        key: entitledPlanKey,
        name: "TEST Ask Entitled Plan",
        tagline: "Has the AI assistant.",
        priceInPaisaMonthly: 100_000,
        maxStaff: null,
        maxBranches: null,
        highlight: false,
        features: [],
        featureKeys: ["ai_assistant"],
        aiMonthlyRequestLimit: 1000,
        sortOrder: 900,
        isActive: true,
      },
      {
        key: unentitledPlanKey,
        name: "TEST Ask Unentitled Plan",
        tagline: "Does not have the AI assistant.",
        priceInPaisaMonthly: 50_000,
        maxStaff: null,
        maxBranches: null,
        highlight: false,
        features: [],
        featureKeys: [],
        aiMonthlyRequestLimit: null,
        sortOrder: 901,
        isActive: true,
      },
      {
        key: lowLimitPlanKey,
        name: "TEST Ask Low Limit Plan",
        tagline: "Has the AI assistant with a tiny quota.",
        priceInPaisaMonthly: 100_000,
        maxStaff: null,
        maxBranches: null,
        highlight: false,
        features: [],
        featureKeys: ["ai_assistant"],
        aiMonthlyRequestLimit: 1,
        sortOrder: 902,
        isActive: true,
      },
    ]);

    const [entitled, unentitled, quotaExceeded] = await db
      .insert(schema.restaurants)
      .values([
        {
          slug: `test-ask-entitled-${suffix}`,
          name: "TEST Ask Entitled Restaurant",
          subscriptionStatus: "active",
          planKey: entitledPlanKey,
          isActive: true,
        },
        {
          slug: `test-ask-unentitled-${suffix}`,
          name: "TEST Ask Unentitled Restaurant",
          subscriptionStatus: "active",
          planKey: unentitledPlanKey,
          isActive: true,
        },
        {
          slug: `test-ask-quota-${suffix}`,
          name: "TEST Ask Quota Exceeded Restaurant",
          subscriptionStatus: "active",
          planKey: lowLimitPlanKey,
          isActive: true,
        },
      ])
      .returning({ id: schema.restaurants.id });
    entitledRestaurantId = entitled.id;
    unentitledRestaurantId = unentitled.id;
    quotaExceededRestaurantId = quotaExceeded.id;

    // Use up the quota-exceeded restaurant's one allowed request.
    await usageDb.recordAiUsage({
      restaurantId: quotaExceededRestaurantId,
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      promptTokens: 10,
      completionTokens: 10,
      totalTokens: 20,
      estimatedCostInPaisa: 0,
      success: true,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    if (originalKey === undefined) delete process.env.AI_CONFIG_ENCRYPTION_KEY;
    else process.env.AI_CONFIG_ENCRYPTION_KEY = originalKey;

    await db.delete(schema.aiUsageLogs).where(eq(schema.aiUsageLogs.restaurantId, entitledRestaurantId));
    await db.delete(schema.aiUsageLogs).where(eq(schema.aiUsageLogs.restaurantId, quotaExceededRestaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, entitledRestaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, unentitledRestaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, quotaExceededRestaurantId));
    await db.delete(schema.plans).where(eq(schema.plans.key, entitledPlanKey));
    await db.delete(schema.plans).where(eq(schema.plans.key, unentitledPlanKey));
    await db.delete(schema.plans).where(eq(schema.plans.key, lowLimitPlanKey));
  });

  it("throws AiAssistantNotEntitledError for a restaurant whose plan lacks the ai_assistant feature key", async () => {
    await expect(
      askDb.askAssistantForRestaurant(unentitledRestaurantId, { systemPrompt: "S", question: "Q" }),
    ).rejects.toBeInstanceOf(askDb.AiAssistantNotEntitledError);
  });

  it("throws AiAssistantQuotaExceededError once the restaurant has used its monthly quota", async () => {
    const failure = await askDb
      .askAssistantForRestaurant(quotaExceededRestaurantId, { systemPrompt: "S", question: "Q" })
      .catch((e) => e);
    expect(failure).toBeInstanceOf(askDb.AiAssistantQuotaExceededError);
    expect(failure.limit).toBe(1);
    expect(failure.used).toBe(1);
  });

  it("an entitled, under-quota restaurant succeeds and records one usage row", async () => {
    // Inserted and torn down immediately around this one test (rather than
    // for the whole file) to keep the window where ai_provider_configs has
    // an enabled row as small as possible — see the file-level comment.
    const testProvider = `test-ask-groq-${suffix}`;
    await providerConfigDb.upsertProviderConfig({
      provider: testProvider,
      apiKey: "test-key",
      model: "llama-3.3-70b-versatile",
      apiUrl: "https://api.groq.com/openai/v1/chat/completions",
      isEnabled: true,
      priority: -1000,
    });

    try {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: "The answer." }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        }),
      );

      const before = await usageDb.countAiRequestsThisMonth(entitledRestaurantId);
      const result = await askDb.askAssistantForRestaurant(entitledRestaurantId, {
        systemPrompt: "S",
        question: "Q",
      });
      expect(result.answer).toBe("The answer.");

      const after = await usageDb.countAiRequestsThisMonth(entitledRestaurantId);
      expect(after).toBe(before + 1);
    } finally {
      await db.delete(schema.aiProviderConfigs).where(eq(schema.aiProviderConfigs.provider, testProvider));
    }
  });
});
