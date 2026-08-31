import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { restaurants } from "@/db/schema";
import { requirePlatformPermission } from "@/lib/rbac/guard";
import { PLATFORM_PERMISSIONS } from "@/lib/rbac/platform-permissions";
import { parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { setAiLimitOverrideSchema } from "@/lib/validation/ai-provider";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Sets or clears one restaurant's AI monthly-request quota override
 * (restaurants.aiMonthlyRequestLimitOverride — see that column's schema
 * comment). Gated MANAGE_AI_PROVIDERS, same tier as the provider config
 * routes — this is the per-tenant half of the same "AI Provider Control
 * Center" admin surface, not a general tenant-editing permission.
 */
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ restaurantId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const session = await requirePlatformPermission(PLATFORM_PERMISSIONS.MANAGE_AI_PROVIDERS);
    const { restaurantId } = await ctx.params;

    const [existing] = await db
      .select({ id: restaurants.id })
      .from(restaurants)
      .where(eq(restaurants.id, restaurantId))
      .limit(1);
    if (!existing) {
      return NextResponse.json({ error: "Restaurant not found." }, { status: 404 });
    }

    const parsed = await parseJsonBody(request, setAiLimitOverrideSchema);
    if (!parsed.ok) return parsed.response;
    const { aiMonthlyRequestLimitOverride } = parsed.data;

    const [updated] = await db
      .update(restaurants)
      .set({ aiMonthlyRequestLimitOverride, updatedAt: new Date() })
      .where(eq(restaurants.id, restaurantId))
      .returning({ aiMonthlyRequestLimitOverride: restaurants.aiMonthlyRequestLimitOverride });

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "restaurant.ai_limit_override_set",
      resourceType: "restaurant",
      resourceId: restaurantId,
      ipAddress: getClientIp(request),
      metadata: { aiMonthlyRequestLimitOverride },
    });

    return NextResponse.json({ aiMonthlyRequestLimitOverride: updated.aiMonthlyRequestLimitOverride });
  } catch (err) {
    return toErrorResponse(err);
  }
}
