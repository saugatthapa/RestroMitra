# Phase 11d — AI assistant (owner/manager analytics Q&A)

Phase 11 had four sub-areas: multi-branch support (11a), offline POS (11b),
payment gateway integrations (11c), and an AI assistant. The user's answer
on scope covered three distinct assistant ideas — owner/manager analytics
Q&A, a customer-facing ordering assistant, and a staff/menu helper — which
is really three separate features, not one. This sub-phase (11d) builds the
first and most concretely scoped of the three: a chat box on the dashboard
where an owner/manager can ask natural-language questions about their own
restaurant's sales, top items, and expenses. The other two (a customer-
facing ordering assistant on the public QR page, and an internal staff/menu
helper) are real, separately-scoped follow-ups — see "Next steps."

## Why analytics Q&A first

Of the three, this one has the smallest and safest surface: it's
authenticated (gated behind the same `VIEW_REPORTS` permission the Reports
dashboard already uses), it only ever reads data, and its entire "universe
of facts" is a single server-computed snapshot handed to it — it never
touches the database directly. The customer-facing ordering assistant would
need its own abuse/rate-limit story (unauthenticated, public-internet
surface, same category of concern as the QR order endpoint) and a cart-
mutation trust boundary; the staff/menu helper is lower-value and vaguer in
scope. Building the bounded, clearly-valuable one first, then coming back
for the others, follows the same incremental pattern every other Phase 11
sub-area used.

## What's done and verified

- **`src/lib/ai/config.ts`** — `getAnthropicConfig()`. Unlike eSewa (Phase
  11c), there's no shared/public sandbox key for an LLM API — every account
  needs its own, and a call costs real money the moment it succeeds. So,
  same pattern as Khalti, `ANTHROPIC_API_KEY` is a **required** env var with
  no fallback; calling this without it throws immediately with an actionable
  message pointing at `console.anthropic.com`. `ANTHROPIC_MODEL` is a
  separate, optional env var (default: a fast/cheap model) rather than a
  hardcoded string — model names/aliases get retired over time, so this
  keeps that a one-line env change instead of a code change.
- **`src/lib/ai/assistant.ts`**:
  - `buildSystemPrompt(restaurantName, summary)` — pure function. Takes the
    *exact same* `getReportSummary()` snapshot the Reports dashboard already
    computes (Phase 9 — tenant-scoped by construction, since the caller
    already resolved `restaurantId` server-side) and serializes it into the
    system prompt as the model's entire universe of facts, with an explicit
    instruction to answer only from what's given and say so plainly if
    asked about anything else (a different date range, inventory, staff
    details, a specific customer — none of which are in this snapshot).
    This is deliberately NOT "give the model a database connection / let it
    write SQL" — that would mean either re-deriving tenant isolation inside
    a prompt (a prompt-injection path to another restaurant's data waiting
    to happen) or trusting the model to always scope its own queries
    correctly, neither of which is a bet worth making. The assistant can be
    wrong about which facts matter to a question, but it structurally
    cannot leak data it was never handed in the first place.
  - `askAssistant()` — calls the Anthropic Messages API with an injectable
    `fetchImpl` (default global `fetch`), same pattern as Khalti's
    `initiateKhaltiPayment()`/`lookupKhaltiPayment()` in Phase 11c — so the
    request shape, auth header, and response parsing are all unit-testable
    without a real key or live network.
- **`POST /api/restaurants/[slug]/assistant/ask`** (authenticated,
  `VIEW_REPORTS`) — validates the question (1–500 chars), rate-limits per
  authenticated user (20 requests / 10 minutes — an LLM call costs money the
  moment it succeeds, so this caps runaway cost from a buggy client retry
  loop or a curious staff member, even though the endpoint already requires
  a permissioned session), computes the trailing-30-day `getReportSummary()`
  snapshot, builds the system prompt, and calls the assistant. A failure —
  including a missing `ANTHROPIC_API_KEY` — is caught and returns a `502`
  with a clear, actionable message rather than crashing or hanging.
- **`/dashboard/assistant`** — a simple chat UI: example-prompt chips for a
  first-time user, a text input, and a running Q&A thread. Gated at the page
  level exactly like `/dashboard/reports` (same `roleHasPermission` check,
  same redirect-to-`/dashboard` pattern), and added to the sidebar nav.
- **Tests**: `assistant.test.ts` (10 cases) — `buildSystemPrompt` embeds the
  restaurant name/date range/formatted figures correctly, includes the
  "only use the data given" instruction, and handles an all-zero range
  without crashing; `askAssistant` sends the correct auth headers and body
  shape via a mocked `fetchImpl`, and throws `AssistantApiError` on a
  non-ok status, a missing text content block, or a malformed body.
  `config.test.ts` (3 cases) — throws when `ANTHROPIC_API_KEY` is unset,
  defaults to the expected model, and respects an `ANTHROPIC_MODEL`
  override. 344 tests total after this phase (up from 334), all passing.
- **Live smoke test** (`scripts/smoke-test-phase11d.sh`, 10 assertions, all
  passing) against the real running server/database: registration/
  onboarding, the ask endpoint reaching the real LLM-calling code path and
  failing *gracefully* (502 with the expected message, not a 500 crash —
  see "Known limitation" below), request validation (empty and over-length
  questions both rejected with 400), permission gating (a seeded waiter
  account, which doesn't have `VIEW_REPORTS` by default, is rejected with
  403), an unauthenticated request rejected with 401, and the dashboard page
  loading for an authorized owner.
- **Playwright screenshots** (`scripts/screenshot-phase11d.mjs`) — the
  assistant page's empty state with the example-prompt chips, and, after
  asking a real question through the real UI, the graceful "AI assistant
  isn't configured yet" error rendered inline in the chat thread — proving
  the whole request/response/error-display path works end to end, short of
  the one piece (an actual LLM response) that needs a real API key.

## Known limitation — no live LLM round trip was possible from here

Disclosed the same way Phase 11c disclosed Khalti's gap: this build
environment has **no `ANTHROPIC_API_KEY`**, so no request to the real
Anthropic API could be made from here — everything network-shaped is tested
against a mocked `fetchImpl` instead (`assistant.test.ts`). Unlike Khalti's
situation, though, **outbound network access to `api.anthropic.com` is NOT
blocked** in this sandbox — a `curl` to the Messages endpoint reaches the
real API and gets a real (401, no key) response back — so the *only*
missing piece is the key itself, not a network restriction. Before relying
on this in production: set `ANTHROPIC_API_KEY` (and optionally
`ANTHROPIC_MODEL`, if the current default has since been retired — check
https://docs.claude.com/en/docs/about-claude/models) and manually ask the
assistant a real question once to confirm the live response quality reads
the way you want it to; the request/response *plumbing* is verified, but
"does the model give a good answer to a real owner's question" is a
different claim that can only be checked with a real key.

## Known gaps / deliberately deferred

- **Fixed trailing-30-day window only** — there's no way yet to ask about
  a different range ("how did last month compare to this month") from the
  chat itself; the assistant only ever sees the same 30-day snapshot
  `getReportSummary()`'s other callers default to. A natural follow-up
  would be letting the assistant recognize a date range in the question and
  re-fetch a different snapshot, but that adds real complexity (parsing a
  fuzzy natural-language range safely, validating it server-side) that felt
  like its own follow-up rather than something to fold in here.
- **No conversation memory across questions.** Each question is answered
  independently from the same static snapshot — asking a follow-up like
  "and what about last week specifically?" won't have any memory of the
  previous answer, because the whole point of this architecture is that the
  assistant never gets more context than one deliberately-scoped snapshot
  per call. Multi-turn context would need its own design pass (how much
  prior conversation to include, whether it should be able to ask a
  follow-up-shaped question that changes the snapshot fetched, etc.).
- **No usage/cost tracking or admin visibility.** The rate limiter caps
  abuse but there's no dashboard (platform-admin or per-restaurant) showing
  how many questions were asked or what that's costing — worth adding once
  this is live with a real key and real usage.
- **The customer-facing ordering assistant and the staff/menu helper are
  not built.** Both were part of the scope answer but are meaningfully
  different features (different auth boundary, different abuse surface,
  different value proposition) — see "Next steps."

## Next steps

1. Set `ANTHROPIC_API_KEY` in an environment with real network access and
   manually verify a live question/answer round trip — the single
   highest-value follow-up specific to this phase (see "Known limitation").
2. Scope and build the **customer-facing ordering assistant** (a chat widget
   on the public `/order/[token]` page that helps a customer pick items and
   can add them to their cart) as its own sub-phase — it's unauthenticated
   and public-internet-facing, so it needs its own rate-limiting/abuse
   design before it's safe to ship, much like the public order-submission
   endpoint from Phase 3/4.
3. Scope and build the **staff/menu helper** (explaining menu items/
   allergens, drafting descriptions for new items) as its own sub-phase.
4. Same standing item as every phase: run this against a real Supabase
   project once live credentials are available.
5. Push to GitHub from your machine.

With 11a/11b/11c/11d done, every self-contained piece of Phase 11 that
didn't need a further user decision is now complete.
