import { NextResponse } from "next/server";
import { requirePlatformPermission } from "@/lib/rbac/guard";
import { PLATFORM_PERMISSIONS } from "@/lib/rbac/platform-permissions";
import { toErrorResponse } from "@/lib/api-route-helpers";
import { getPlatformAiUsageSummary, getRecentAiUsageEvents } from "@/lib/ai/usage-db";

/**
 * Platform-wide AI usage/cost dashboard data for /admin/ai-providers —
 * per-restaurant totals for the current UTC calendar month plus a recent
 * activity feed. Gated MANAGE_AI_PROVIDERS, same tier as the provider
 * config routes (this is all part of the same admin surface).
 */
export async function GET() {
  try {
    await requirePlatformPermission(PLATFORM_PERMISSIONS.MANAGE_AI_PROVIDERS);
    const [byRestaurant, recentEvents] = await Promise.all([
      getPlatformAiUsageSummary(),
      getRecentAiUsageEvents(50),
    ]);
    return NextResponse.json({ byRestaurant, recentEvents });
  } catch (err) {
    return toErrorResponse(err);
  }
}
