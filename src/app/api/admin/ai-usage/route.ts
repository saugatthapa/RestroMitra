import { NextResponse } from "next/server";
import { requirePlatformPermission } from "@/lib/rbac/guard";
import { PLATFORM_PERMISSIONS } from "@/lib/rbac/platform-permissions";
import { toErrorResponse } from "@/lib/api-route-helpers";
import { getPlatformAiUsageSummary, getRecentAiUsageEvents } from "@/lib/ai/usage-db";
import { rateLimit } from "@/lib/rate-limit";

/**
 * Platform-wide AI usage/cost dashboard data for /admin/ai-providers —
 * per-restaurant totals for the current UTC calendar month plus a recent
 * activity feed. Gated MANAGE_AI_PROVIDERS, same tier as the provider
 * config routes (this is all part of the same admin surface).
 */
export async function GET() {
  try {
    const session = await requirePlatformPermission(PLATFORM_PERMISSIONS.MANAGE_AI_PROVIDERS);

    // QA hardening (P2 backlog) — see ai-providers/route.ts's matching
    // comment; shares the same admin-read:user bucket.
    const limit = await rateLimit(`admin-read:user:${session.user.id}`, { limit: 120, windowMs: 60 * 1000 });
    if (!limit.allowed) {
      return NextResponse.json({ error: "Too many requests. Please wait a moment." }, { status: 429 });
    }

    const [byRestaurant, recentEvents] = await Promise.all([
      getPlatformAiUsageSummary(),
      getRecentAiUsageEvents(50),
    ]);
    return NextResponse.json({ byRestaurant, recentEvents });
  } catch (err) {
    return toErrorResponse(err);
  }
}
