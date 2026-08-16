import "server-only";

/**
 * Phase 11d — AI assistant configuration.
 *
 * Phase 14 — added Groq as a second provider (and made it the default). Both
 * providers need a real account/key — there's no publicly shared sandbox key
 * for an LLM API — so each provider's API key is a required env var with no
 * fallback: building that provider's config without its key throws
 * immediately with an actionable message, rather than silently building
 * requests that will fail.
 *
 * AI_PROVIDER selects which one `getAiConfig()` (called by `askAssistant()`
 * whenever it's not given an explicit config) builds — "groq" or
 * "anthropic", defaulting to "groq" per this project's chosen provider (a
 * generous free tier suits an add-on analytics assistant better than a
 * pay-per-token-only API for a restaurant that may not use it daily). Both
 * configs stay fully implemented and independently testable — switching
 * providers later is a one-line env var change, not a rewrite.
 *
 * *_MODEL is deliberately an env var, not hardcoded — model names and
 * aliases are released/retired over time, so pinning one directly in code
 * would silently go stale. Each default below was chosen for a short,
 * data-grounded Q&A assistant (not a large agentic task): override it to
 * whatever's current in the provider's model docs if the default here has
 * since been retired.
 */

export type AnthropicConfig = {
  provider: "anthropic";
  apiKey: string;
  model: string;
  apiUrl: string;
  apiVersion: string;
};

export type GroqConfig = {
  provider: "groq";
  apiKey: string;
  model: string;
  apiUrl: string;
};

export type AiConfig = AnthropicConfig | GroqConfig;

const DEFAULT_ANTHROPIC_MODEL = "claude-3-5-haiku-latest";
const ANTHROPIC_API_VERSION = "2023-06-01";

// llama-3.3-70b-versatile: free-tier eligible on Groq, 131K context, and
// noticeably more reliable than the smaller 8B model at the kind of
// figure-comparison/arithmetic questions an owner asks a sales assistant
// ("which category did best this week?") while still comfortably inside the
// free tier's 30 req/min, 12K tokens/min limits for a low-traffic, one
// restaurant-at-a-time feature that's already server-side rate-limited (see
// the assistant/ask route). llama-3.1-8b-instant is a faster/cheaper
// fallback if a restaurant's usage ever needs the higher 6K TPM headroom
// trade-off — swap via GROQ_MODEL, no code change needed.
const DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile";
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

export function getAnthropicConfig(): AnthropicConfig {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Generate one at https://console.anthropic.com " +
        "(Account Settings -> API Keys) and set it before using the AI assistant.",
    );
  }
  return {
    provider: "anthropic",
    apiKey,
    model: process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL,
    apiUrl: "https://api.anthropic.com/v1/messages",
    apiVersion: ANTHROPIC_API_VERSION,
  };
}

export function getGroqConfig(): GroqConfig {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GROQ_API_KEY is not set. Generate a free key at https://console.groq.com/keys " +
        "and set it before using the AI assistant.",
    );
  }
  return {
    provider: "groq",
    apiKey,
    model: process.env.GROQ_MODEL || DEFAULT_GROQ_MODEL,
    apiUrl: GROQ_API_URL,
  };
}

/**
 * Picks the active provider from AI_PROVIDER (default "groq") and builds
 * its config. The one place a route/caller goes to get "whichever provider
 * this deployment is configured to use" without needing to know which one
 * that is.
 */
export function getAiConfig(): AiConfig {
  const provider = (process.env.AI_PROVIDER || "groq").trim().toLowerCase();
  if (provider === "anthropic") return getAnthropicConfig();
  if (provider !== "groq") {
    throw new Error(
      `AI_PROVIDER is set to "${provider}", which isn't a supported value. Use "groq" or "anthropic".`,
    );
  }
  return getGroqConfig();
}
