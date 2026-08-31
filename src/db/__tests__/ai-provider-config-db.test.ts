/**
 * Platform Control Center, Phase 7 — integration test for the DB-backed AI
 * provider config (src/lib/ai/provider-config-db.ts): upsert, redaction,
 * and resolveAiProviderChain()'s DB-vs-env-fallback behavior. Skipped (not
 * failed) when DATABASE_URL isn't set, same convention as plans-db.test.ts.
 *
 * Uses a fresh, randomly generated AI_CONFIG_ENCRYPTION_KEY for the
 * duration of this suite (restored afterAll) — these tests never depend on
 * whatever key (if any) a real deployment has configured.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("provider-config-db (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let providerConfigDb: typeof import("@/lib/ai/provider-config-db");

  const originalKey = process.env.AI_CONFIG_ENCRYPTION_KEY;
  // Two distinct providers so priority ordering is actually observable —
  // the schema's unique index is on `provider`, so a single provider can
  // only ever have one row.
  const testGroqProvider = "groq";
  const testAnthropicProvider = "anthropic";

  beforeAll(async () => {
    process.env.AI_CONFIG_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    providerConfigDb = await import("@/lib/ai/provider-config-db");
  });

  afterEach(async () => {
    await db.delete(schema.aiProviderConfigs).where(eq(schema.aiProviderConfigs.provider, testGroqProvider));
    await db.delete(schema.aiProviderConfigs).where(eq(schema.aiProviderConfigs.provider, testAnthropicProvider));
  });

  afterAll(() => {
    if (originalKey === undefined) delete process.env.AI_CONFIG_ENCRYPTION_KEY;
    else process.env.AI_CONFIG_ENCRYPTION_KEY = originalKey;
  });

  it("upsertProviderConfig creates a row and getAllProviderConfigsForAdmin never exposes the key", async () => {
    await providerConfigDb.upsertProviderConfig({
      provider: testGroqProvider,
      apiKey: "gsk_test_key_value",
      model: "llama-3.3-70b-versatile",
      apiUrl: "https://api.groq.com/openai/v1/chat/completions",
      isEnabled: true,
      priority: 0,
    });

    const configs = await providerConfigDb.getAllProviderConfigsForAdmin();
    const row = configs.find((c) => c.provider === testGroqProvider);
    expect(row).toBeDefined();
    expect(row?.hasApiKey).toBe(true);
    expect(row).not.toHaveProperty("apiKey");
    expect(row).not.toHaveProperty("apiKeyCiphertext");
    expect(JSON.stringify(row)).not.toContain("gsk_test_key_value");
  });

  it("upsertProviderConfig on the same provider updates the existing row rather than duplicating", async () => {
    await providerConfigDb.upsertProviderConfig({
      provider: testGroqProvider,
      apiKey: "first-key",
      model: "model-a",
      apiUrl: "https://example.com/a",
      isEnabled: true,
      priority: 0,
    });
    await providerConfigDb.upsertProviderConfig({
      provider: testGroqProvider,
      apiKey: "second-key",
      model: "model-b",
      apiUrl: "https://example.com/b",
      isEnabled: false,
      priority: 3,
    });

    const configs = await providerConfigDb.getAllProviderConfigsForAdmin();
    const matches = configs.filter((c) => c.provider === testGroqProvider);
    expect(matches).toHaveLength(1);
    expect(matches[0].model).toBe("model-b");
    expect(matches[0].isEnabled).toBe(false);
    expect(matches[0].priority).toBe(3);
  });

  it("upsertProviderConfig with a blank apiKey on an edit keeps the existing ciphertext (chain still resolves)", async () => {
    await providerConfigDb.upsertProviderConfig({
      provider: testGroqProvider,
      apiKey: "keep-me",
      model: "model-a",
      apiUrl: "https://example.com/a",
      isEnabled: true,
      priority: 0,
    });
    await providerConfigDb.upsertProviderConfig({
      provider: testGroqProvider,
      apiKey: "",
      model: "model-a-renamed",
      apiUrl: "https://example.com/a",
      isEnabled: true,
      priority: 0,
    });

    const chain = await providerConfigDb.resolveAiProviderChain();
    const entry = chain.find((c) => c.provider === testGroqProvider && c.model === "model-a-renamed");
    expect(entry).toBeDefined();
    expect(entry?.apiKey).toBe("keep-me");
  });

  it("resolveAiProviderChain falls back to the env-based config when no row is enabled", async () => {
    // No rows inserted in this test at all — the empty-table case.
    const chain = await providerConfigDb.resolveAiProviderChain();
    expect(chain).toHaveLength(1);
    // The env fallback (.env.local sets AI_PROVIDER=groq) — assert only the
    // shape that's stable regardless of the real env's exact key, since
    // this suite doesn't control GROQ_API_KEY.
    expect(chain[0].provider === "groq" || chain[0].provider === "anthropic").toBe(true);
  });

  it("resolveAiProviderChain builds the chain from enabled DB rows ordered by priority, decrypting each key", async () => {
    await providerConfigDb.upsertProviderConfig({
      provider: testAnthropicProvider,
      apiKey: "anthropic-secret",
      model: "claude-3-5-haiku-latest",
      apiUrl: "https://api.anthropic.com/v1/messages",
      isEnabled: true,
      priority: 5,
    });
    await providerConfigDb.upsertProviderConfig({
      provider: testGroqProvider,
      apiKey: "groq-secret",
      model: "llama-3.3-70b-versatile",
      apiUrl: "https://api.groq.com/openai/v1/chat/completions",
      isEnabled: true,
      priority: 1,
    });

    const chain = await providerConfigDb.resolveAiProviderChain();
    expect(chain).toHaveLength(2);
    // priority 1 (groq) before priority 5 (anthropic).
    expect(chain[0].provider).toBe("groq");
    expect(chain[0].apiKey).toBe("groq-secret");
    expect(chain[1].provider).toBe("anthropic");
    expect(chain[1].apiKey).toBe("anthropic-secret");
  });

  it("resolveAiProviderChain excludes a disabled row", async () => {
    await providerConfigDb.upsertProviderConfig({
      provider: testGroqProvider,
      apiKey: "disabled-secret",
      model: "llama-3.3-70b-versatile",
      apiUrl: "https://api.groq.com/openai/v1/chat/completions",
      isEnabled: false,
      priority: 0,
    });

    // With the only row disabled, this behaves like the empty-table case:
    // falls back to env config.
    const chain = await providerConfigDb.resolveAiProviderChain();
    expect(chain.every((c) => c.apiKey !== "disabled-secret")).toBe(true);
  });

  it("deleteProviderConfig removes a row entirely", async () => {
    const created = await providerConfigDb.upsertProviderConfig({
      provider: testGroqProvider,
      apiKey: "to-be-deleted",
      model: "llama-3.3-70b-versatile",
      apiUrl: "https://api.groq.com/openai/v1/chat/completions",
      isEnabled: true,
      priority: 0,
    });
    await providerConfigDb.deleteProviderConfig(created.id);

    const configs = await providerConfigDb.getAllProviderConfigsForAdmin();
    expect(configs.some((c) => c.id === created.id)).toBe(false);
  });
});
