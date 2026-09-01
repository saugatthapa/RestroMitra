import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { restaurants } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { askAssistantSchema } from "@/lib/validation/assistant";
import { getReportSummary } from "@/lib/reports";
import { buildSystemPrompt, AssistantApiError, AssistantAllProvidersFailedError } from "@/lib/ai/assistant";
import {
  askAssistantForRestaurant,
  AiAssistantNotEntitledError,
  AiAssistantQuotaExceededError,
} from "@/lib/ai/ask-db";
import { hasValidCsrfHeader } from "@/lib/request";
import { rateLimit } from "@/lib/rate-limit";
import { restaurantDate } from "@/lib/restaurant-date";

const RANGE_DAYS = 30;

function daysAgoIso(timezone: string, days: number) {
  return restaurantDate(timezone, new Date(Date.now() - days * 86_400_000));
}

/**
 * Phase 11d — the owner/manager analytics assistant's ask endpoint. Gated
 * behind VIEW_REPORTS, the same permission the Reports dashboard uses,
 * since this is answering questions over exactly the same data. Always
 * scoped to the trailing 30 days — same window getReportSummary's callers
 * default to elsewhere — no free-form date range from the client yet (see
 * PHASE_11d_NOTES.md's known gaps).
 *
 * Rate limited per authenticated user (not just IP, unlike the public
 * routes) — an LLM call costs real money the moment it succeeds, so this
 * caps how much a single account, buggy client retry loop, or curious
 * staff member can spend even though the endpoint itself requires an
 * authenticated, permissioned session.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug } = await ctx.params;
    const { session, restaurantId, timezone } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.VIEW_REPORTS,
    );

    const limit = await rateLimit(`assistant:user:${session.user.id}`, {
      limit: 20,
      windowMs: 10 * 60 * 1000,
    });
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "Too many questions in a short time. Please wait a few minutes and try again." },
        { status: 429 },
      );
    }

    const parsed = await parseJsonBody(request, askAssistantSchema);
    if (!parsed.ok) return parsed.response;
    const { question } = parsed.data;

    const [restaurant] = await db
      .select({ name: restaurants.name })
      .from(restaurants)
      .where(eq(restaurants.id, restaurantId))
      .limit(1);

    const range = { from: daysAgoIso(timezone, RANGE_DAYS - 1), to: restaurantDate(timezone) };
    const summary = await getReportSummary(restaurantId, range, timezone);
    const systemPrompt = buildSystemPrompt(restaurant?.name ?? "your restaurant", summary);

    try {
      const { answer } = await askAssistantForRestaurant(restaurantId, { systemPrompt, question });
      return NextResponse.json({ answer, range });
    } catch (err) {
      // Phase 7 — entitlement/quota failures are distinct from provider
      // failures: they're an expected, informative outcome for the user
      // (upgrade your plan / wait until next month), not a 502.
      if (err instanceof AiAssistantNotEntitledError) {
        return NextResponse.json(
          { error: "The AI assistant isn't included in your current plan." },
          { status: 403 },
        );
      }
      if (err instanceof AiAssistantQuotaExceededError) {
        return NextResponse.json(
          {
            error: `This restaurant has reached its AI assistant quota for this month (${err.used}/${err.limit} requests). The quota resets on the 1st.`,
          },
          { status: 429 },
        );
      }

      // Phase 14: the "not configured" message now applies to either
      // provider — getAiConfig()/getGroqConfig()/getAnthropicConfig() all
      // throw a plain Error whose message contains this phrase when the
      // relevant *_API_KEY env var is missing. Deliberately not forwarding
      // err.message itself to the client — it names the exact env var and a
      // setup URL, useful in a server log but not something every
      // VIEW_REPORTS-permissioned staff member needs to see.
      const detail =
        err instanceof Error && /_API_KEY is not set\./.test(err.message)
          ? "The AI assistant isn't configured yet — ask an administrator to set it up."
          : "The AI assistant is temporarily unavailable. Please try again shortly.";
      console.error(
        "AI assistant request failed:",
        err instanceof AssistantApiError
          ? { status: err.status, body: err.body }
          : err instanceof AssistantAllProvidersFailedError
            ? { attempts: err.attempts.map((a) => ({ provider: a.provider, model: a.model })) }
            : err,
      );
      return NextResponse.json({ error: detail }, { status: 502 });
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}
