import { NextResponse } from "next/server";
import { db } from "@/db";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { upgradeRequestSchema } from "@/lib/validation/subscription";
import { recordSubscriptionEvent } from "@/lib/subscription-db";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * An owner asking to move to a different plan. There's no payment gateway
 * yet (Phase 11), so this deliberately does NOT change the restaurant's
 * subscriptionStatus/planKey itself — it only logs the request as a
 * subscription_events row a platform admin sees and acts on (via
 * /admin/restaurants/[id], the assign_plan action), the same "request,
 * then a human on the other side fulfills it" flow a pre-self-serve-
 * billing SaaS realistically has.
 *
 * Gated MANAGE_SUBSCRIPTION (owner-only by default) but explicitly allows
 * inactive-subscription access — an owner whose trial just expired is
 * exactly who needs to be able to submit this request.
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
    const { session, restaurantId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_SUBSCRIPTION,
      { allowInactiveSubscription: true },
    );

    const parsed = await parseJsonBody(request, upgradeRequestSchema);
    if (!parsed.ok) return parsed.response;

    await db.transaction(async (tx) => {
      await recordSubscriptionEvent(tx, {
        restaurantId,
        eventType: "upgrade_requested",
        planKey: parsed.data.planKey,
        note: parsed.data.note ?? null,
        performedByUserId: session.user.id,
      });
    });

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "subscription.upgrade_requested",
      resourceType: "restaurant",
      resourceId: restaurantId,
      ipAddress: getClientIp(request),
      metadata: { planKey: parsed.data.planKey },
    });

    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
