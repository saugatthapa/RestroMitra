/**
 * Platform Control Center (Phase 7) — a rough per-call cost ESTIMATE for
 * the AI usage ledger (ai_usage_logs.estimatedCostInPaisa). Deliberately
 * pure/dependency-free (no DB, no env) so it's directly unit-testable.
 *
 * This is NOT a billing-accurate figure — providers don't return per-call
 * cost, only token counts, and this multiplies those counts by a
 * hand-maintained per-model price table that WILL drift out of date as
 * providers change pricing. Good enough for "which provider/tenant is
 * costing the most, roughly, this month" trend-watching on the platform
 * dashboard; never wire this into anything that bills a restaurant.
 *
 * Prices are USD per 1M tokens (prompt/completion tracked separately,
 * since most providers price them differently), converted to NPR paisa at
 * an approximate, hardcoded exchange rate — see NPR_PER_USD's own comment.
 * Unknown provider/model pairs (a config an admin adds that isn't in this
 * table yet) return null cost rather than guessing, and null cost is
 * always shown as "—" (not Rs 0) so it's never confused with an actually
 * free call.
 */

export type AiCostRatesUsdPerMillionTokens = {
  prompt: number;
  completion: number;
};

// Approximate NPR/USD rate for internal cost-trend estimation only —
// review and bump periodically; a stale rate doesn't corrupt anything
// billing-critical since nothing here is charged to a restaurant.
const NPR_PER_USD = 133;

// Groq's free tier (the default provider — see src/lib/ai/config.ts)
// covers typical usage at $0; a paid Groq tier exists but this project's
// default llama-3.3-70b-versatile model targets the free tier. Anthropic
// Claude Haiku rates are its published per-token pricing at the time this
// was written. A provider/model pair not listed here (a custom model an
// admin configures) simply has no cost estimate — see estimateCostInPaisa.
const COST_RATES: Record<string, Record<string, AiCostRatesUsdPerMillionTokens>> = {
  groq: {
    "llama-3.3-70b-versatile": { prompt: 0, completion: 0 },
    "llama-3.1-8b-instant": { prompt: 0, completion: 0 },
  },
  anthropic: {
    "claude-3-5-haiku-latest": { prompt: 0.8, completion: 4 },
  },
};

/**
 * Estimated cost in paisa for one call, or null if the provider/model pair
 * has no known rate (never assume $0 for an unknown pair — that would
 * silently hide a real cost).
 */
export function estimateCostInPaisa(
  provider: string,
  model: string,
  promptTokens: number | null | undefined,
  completionTokens: number | null | undefined,
): number | null {
  const rates = COST_RATES[provider]?.[model];
  if (!rates) return null;
  const promptCostUsd = ((promptTokens ?? 0) / 1_000_000) * rates.prompt;
  const completionCostUsd = ((completionTokens ?? 0) / 1_000_000) * rates.completion;
  const totalCostUsd = promptCostUsd + completionCostUsd;
  return Math.round(totalCostUsd * NPR_PER_USD * 100);
}
