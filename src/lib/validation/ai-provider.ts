import { z } from "zod";

/**
 * Platform Control Center (Phase 7) — the two providers src/lib/ai/
 * assistant.ts actually knows how to call (askGroq/askAnthropic). A row
 * naming anything else would build a config askAssistant() can't dispatch
 * on, so this is enforced here rather than left to the DB's plain varchar
 * column (see aiProviderConfigs' own schema comment).
 */
export const KNOWN_AI_PROVIDERS = ["groq", "anthropic"] as const;

const providerFieldSchema = z.enum(KNOWN_AI_PROVIDERS);

/**
 * Creating or fully replacing a provider row. `apiKey` is required here —
 * you can't configure a provider for the first time without a key.
 */
export const createAiProviderConfigSchema = z.object({
  provider: providerFieldSchema,
  apiKey: z.string().trim().min(1, "Enter an API key."),
  model: z.string().trim().min(1, "Enter a model name.").max(100),
  apiUrl: z.string().trim().url("Enter a valid URL."),
  isEnabled: z.boolean(),
  priority: z.number().int().min(0),
});

/**
 * Editing an existing provider row. `apiKey` is optional and, when omitted
 * or blank, leaves the stored key untouched (see upsertProviderConfig in
 * provider-config-db.ts) — an admin re-saving priority/isEnabled shouldn't
 * be forced to re-paste a secret they already entered.
 */
export const updateAiProviderConfigSchema = z.object({
  provider: providerFieldSchema,
  apiKey: z.string().trim().max(500).optional(),
  model: z.string().trim().min(1, "Enter a model name.").max(100),
  apiUrl: z.string().trim().url("Enter a valid URL."),
  isEnabled: z.boolean(),
  priority: z.number().int().min(0),
});

export type CreateAiProviderConfigInput = z.infer<typeof createAiProviderConfigSchema>;
export type UpdateAiProviderConfigInput = z.infer<typeof updateAiProviderConfigSchema>;

/** Setting a per-restaurant AI quota override (restaurants.aiMonthlyRequestLimitOverride) — null clears it back to the plan's own limit. */
export const setAiLimitOverrideSchema = z.object({
  aiMonthlyRequestLimitOverride: z.number().int().min(0).nullable(),
});
