# Phase 14 — Groq-powered AI assistant

Scope: swap the owner/manager analytics assistant (built in Phase 11d) from
Anthropic-only to a provider-abstracted design that defaults to **Groq's free
tier**, using the user-supplied test API key, while keeping Anthropic fully
supported as an explicit opt-in fallback. Requested directly by the user:
*"for ai i want to use groq free tier so use groq free ai model that is
suitable for this project."*

## Why this matters

The assistant itself (what data it can see, how the system prompt is built,
tenant isolation) was already correct from Phase 11d — this phase is purely
about *which model answers the question* and *how cheaply*. Groq's free tier
means an owner can run the assistant at zero marginal cost, which matters a
lot for a Nepal-market restaurant SaaS where every rupee of infra cost is
scrutinized.

## What's done and verified

- **Model chosen: `llama-3.3-70b-versatile`.** Confirmed via Groq's own docs
  (console.groq.com) at build time: 131K context window, free-tier limits of
  30 requests/min, 1,000 requests/day, 12,000 tokens/min — comfortably above
  what a single restaurant's owner/manager would generate asking a few
  questions a day. Chosen over the faster/cheaper `llama-3.1-8b-instant`
  because this assistant's job is numeric reasoning over a restaurant's
  actual sales figures (comparing revenue, computing shares, reasoning about
  trends) — the larger model is more reliable at that than the 8B one.
- **Provider abstraction** (`src/lib/ai/config.ts`, `src/lib/ai/assistant.ts`):
  `AiConfig` is a discriminated union (`AnthropicConfig | GroqConfig`) tagged
  by `provider`. `getAiConfig()` reads `AI_PROVIDER` (defaults to `"groq"`
  when unset — matches "so use groq" without requiring the user to also set
  an env var) and builds the right config, throwing a clear
  `"GROQ_API_KEY is not set…"` / `"ANTHROPIC_API_KEY is not set…"` error with
  a link to get a free key if the corresponding key is missing.
  `askAssistant()` branches on `config.provider` and calls a
  provider-specific helper (`askGroq()` / `askAnthropic()`) because the two
  APIs' request/response shapes are genuinely different (Groq is
  OpenAI-compatible chat-completions; Anthropic is its own Messages API) —
  faking a shared shape would have been more fragile than branching once at
  the top.
- **The route** (`.../assistant/ask/route.ts`) is provider-agnostic: its
  error-detection regex was generalized from
  `err.message.startsWith("ANTHROPIC_API_KEY")` to `/_API_KEY is not set\./`
  so it catches the missing-key case for either provider, and the user-facing
  message no longer echoes the specific env var name/setup URL (that's an
  operator-facing detail, not something a restaurant staff member asking a
  question should see).
- **The assistant's own knowledge was also widened** this phase (alongside
  the Phase 16 report additions below): `buildSystemPrompt()` now includes
  discounts given, service charge collected, tips collected (Phase 13 data
  that existed in `ReportSummary` but was never surfaced to the model before
  this phase), and the new peak-hour/completion-rate figures from Phase 16 —
  so "what's my busiest hour" or "how much have I given away in discounts"
  are now answerable, not just sales/expenses/top-items.
- **Unit tests**: `src/lib/ai/assistant.test.ts` — 12/12 passing. Covers both
  providers' request shape (headers, body), both providers' error handling
  (non-200, malformed body, missing message content), and a dedicated test
  that the *default* provider (no config passed) is Groq when `AI_PROVIDER`
  is unset.
- **`.env.local`** (gitignored, never committed) has the user's real test key
  configured: `AI_PROVIDER=groq`, `GROQ_API_KEY=<the key the user provided>`,
  `GROQ_MODEL=llama-3.3-70b-versatile`. `.env.example` documents both
  providers, Groq first (as the default), Anthropic commented out as the
  alternate.
- **Live pipeline verification**: with a real dev server running and a real
  test restaurant/order, `POST /api/restaurants/{slug}/assistant/ask` was
  exercised end to end. Permission check, rate limiting, `getReportSummary()`
  build, `buildSystemPrompt()`, and the actual outbound Groq call all ran
  correctly — the request reached the point of calling `fetch()` against
  `api.groq.com` and failed only because **this specific cloud build
  sandbox's network egress allowlist doesn't include `api.groq.com`** (same
  class of restriction already documented in `PHASE_11c_NOTES.md` for eSewa/
  Khalti; `api.anthropic.com` *was* reachable from this sandbox, which is why
  Phase 11d could live-verify Anthropic but this phase can't live-verify
  Groq the same way). The route degraded exactly as designed: a clean `502`
  ("The AI assistant is temporarily unavailable. Please try again shortly.")
  with a structured server-side log — verified again visually in this phase
  via a screenshot of the Assistant page showing that exact message after
  asking a real question through the UI, not a crash or a stack trace.

## Known limitation — Groq could not be live-verified from this build environment

Exactly the same shape of gap as Phase 11c's Khalti limitation: the code path
is fully correct and fully covered by mocked-fetch unit tests, and the
route's error handling was verified against a *real* network failure (not a
simulated one) live through the running app. What could **not** be verified
from inside this sandbox is an actual successful Groq completion coming back
and being rendered in the chat UI. **This will work as soon as the app runs
somewhere with normal internet access** (any real hosting environment) — there
is no code-level reason it wouldn't; it's purely this sandbox's outbound
allowlist. Recommended action for the user: once deployed (or once running
locally on a machine with normal internet), ask the assistant a question and
confirm a real answer comes back — that's the one piece this build
environment structurally cannot do.

## Known gaps / deliberately deferred

- No per-provider usage/cost dashback (e.g. "you've used 340/1000 requests
  today") — Groq's free-tier limits are generous enough for a single
  restaurant that this wasn't worth building without evidence it's needed.
- No automatic fallback from Groq to Anthropic on a Groq outage — an operator
  who wants that today can set `AI_PROVIDER=anthropic` manually. Automatic
  failover would need a way to distinguish "Groq is down" from "Groq key is
  wrong" from "this sandbox's network is restricted," which isn't reliably
  inferable from a single fetch failure.

## Next steps

- Once deployed with real internet access, live-verify an actual Groq
  completion end to end and confirm answer quality/latency are acceptable
  for real restaurant owners.
- Consider surfacing which provider is currently active somewhere in the
  admin/settings UI (currently only visible via env vars), if multi-provider
  ever becomes something restaurant owners configure themselves rather than
  a platform-level default.
