import "server-only";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { aiProviderConfigs } from "@/db/schema";
import { encryptSecret, decryptSecret } from "./encryption";
import { getAiConfig, type AiConfig } from "./config";

/**
 * Platform Control Center (Phase 7) — DB-backed provider configuration.
 * Every function here hits the database (and, for the key material,
 * src/lib/ai/encryption.ts) — never import this from a client component.
 *
 * Design: a platform admin can configure zero, one, or several provider
 * rows in `ai_provider_configs`. When at least one ENABLED row exists,
 * resolveAiProviderChain() builds the failover chain from those rows
 * (lowest `priority` first) and the env-var-based getAiConfig() is never
 * consulted. When zero rows are enabled (including the common case of the
 * table being completely empty — the state every existing deployment is in
 * today, before any admin has touched /admin/ai-providers), it falls back
 * to the single env-based config exactly as before Phase 7. This means
 * Phase 7 ships with zero behavior change for any deployment until a
 * platform admin actively adds a provider row.
 */

export type AiProviderConfigRow = typeof aiProviderConfigs.$inferSelect;

/** A provider row with its API key redacted — everything the admin UI needs to list/edit configs EXCEPT the actual secret, which never leaves encryptSecret/decryptSecret. */
export type AiProviderConfigSummary = {
  id: string;
  provider: string;
  model: string;
  apiUrl: string;
  isEnabled: boolean;
  priority: number;
  hasApiKey: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function rowToSummary(row: AiProviderConfigRow): AiProviderConfigSummary {
  return {
    id: row.id,
    provider: row.provider,
    model: row.model,
    apiUrl: row.apiUrl,
    isEnabled: row.isEnabled,
    priority: row.priority,
    hasApiKey: row.apiKeyCiphertext.length > 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToAiConfig(row: AiProviderConfigRow): AiConfig {
  const apiKey = decryptSecret(row.apiKeyCiphertext);
  if (row.provider === "anthropic") {
    return {
      provider: "anthropic",
      apiKey,
      model: row.model,
      apiUrl: row.apiUrl,
      apiVersion: "2023-06-01",
    };
  }
  // Every other provider value is treated as Groq's OpenAI-compatible
  // shape — validation (src/lib/validation/ai-provider.ts) only ever lets
  // "groq" or "anthropic" through at write time, so this branch is really
  // just "not anthropic" for the two providers that currently exist.
  return {
    provider: "groq",
    apiKey,
    model: row.model,
    apiUrl: row.apiUrl,
  };
}

/** Every configured provider row, key redacted — for /admin/ai-providers' list view. */
export async function getAllProviderConfigsForAdmin(): Promise<AiProviderConfigSummary[]> {
  const rows = await db.select().from(aiProviderConfigs).orderBy(asc(aiProviderConfigs.priority));
  return rows.map(rowToSummary);
}

/**
 * The actual failover chain to try, in order — DB-backed rows (enabled
 * only, lowest priority first) when any exist, otherwise a single-entry
 * chain built from the env-based getAiConfig(). Throws only in the
 * fallback path, and only with the same actionable "*_API_KEY is not set"
 * error getAiConfig() has always thrown — a genuinely unconfigured
 * deployment (no DB rows, no env vars) still fails the same way it did
 * before Phase 7.
 */
export async function resolveAiProviderChain(): Promise<AiConfig[]> {
  const rows = await db
    .select()
    .from(aiProviderConfigs)
    .where(eq(aiProviderConfigs.isEnabled, true))
    .orderBy(asc(aiProviderConfigs.priority));

  if (rows.length > 0) {
    return rows.map(rowToAiConfig);
  }
  return [getAiConfig()];
}

/**
 * Creates or updates a provider's config row (upsert on the unique
 * `provider` column — one row per provider, matching the schema's
 * ai_provider_configs_provider_unique index). `apiKey` is required when
 * creating; on an edit, omitting or blanking it keeps the existing
 * ciphertext (never wipe a stored key just because the edit form was
 * submitted without re-typing it).
 */
export async function upsertProviderConfig(params: {
  provider: string;
  apiKey?: string | null;
  model: string;
  apiUrl: string;
  isEnabled: boolean;
  priority: number;
}): Promise<AiProviderConfigSummary> {
  const [existing] = await db
    .select()
    .from(aiProviderConfigs)
    .where(eq(aiProviderConfigs.provider, params.provider))
    .limit(1);

  const apiKeyCiphertext =
    params.apiKey && params.apiKey.trim().length > 0
      ? encryptSecret(params.apiKey.trim())
      : (existing?.apiKeyCiphertext ?? null);

  if (!apiKeyCiphertext) {
    throw new Error("An API key is required when configuring a provider for the first time.");
  }

  const [row] = await db
    .insert(aiProviderConfigs)
    .values({
      provider: params.provider,
      apiKeyCiphertext,
      model: params.model,
      apiUrl: params.apiUrl,
      isEnabled: params.isEnabled,
      priority: params.priority,
    })
    .onConflictDoUpdate({
      target: aiProviderConfigs.provider,
      set: {
        apiKeyCiphertext,
        model: params.model,
        apiUrl: params.apiUrl,
        isEnabled: params.isEnabled,
        priority: params.priority,
        updatedAt: new Date(),
      },
    })
    .returning();

  return rowToSummary(row);
}

/** Removes a provider's config row entirely — reverting to the env-based fallback if no other rows are enabled. */
export async function deleteProviderConfig(id: string): Promise<void> {
  await db.delete(aiProviderConfigs).where(eq(aiProviderConfigs.id, id));
}
