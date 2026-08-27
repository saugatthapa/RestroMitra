import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { restaurants } from "@/db/schema";
import { requirePlatformPermission } from "@/lib/rbac/guard";
import { PLATFORM_PERMISSIONS } from "@/lib/rbac/platform-permissions";
import { parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { adminSubscriptionActionSchema } from "@/lib/validation/subscription";
import { recordSubscriptionEvent } from "@/lib/subscription-db";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * The single choke point for every subscription state change a platform
 * admin can make — extending a trial, assigning/activating a plan,
 * marking past-due, cancelling, reactivating. Every action here updates
 * `restaurants.subscription_status`/`plan_key` (the fast-read snapshot)
 * AND appends a subscription_events row (the timeline) in the same
 * transaction, so the two can never drift apart, plus a generic
 * audit_logs row — this is exactly the kind of cross-tenant action
 * requireRestaurantAccess's own comment says must always be logged.
 */
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ restaurantId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const session = await requirePlatformPermission(PLATFORM_PERMISSIONS.MANAGE_SUBSCRIPTIONS);
    const { restaurantId } = await ctx.params;

    const [existing] = await db
      .select({
        subscriptionStatus: restaurants.subscriptionStatus,
        trialEndsAt: restaurants.trialEndsAt,
        planKey: restaurants.planKey,
      })
      .from(restaurants)
      .where(eq(restaurants.id, restaurantId))
      .limit(1);
    if (!existing) {
      return NextResponse.json({ error: "Restaurant not found." }, { status: 404 });
    }

    const parsed = await parseJsonBody(request, adminSubscriptionActionSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const fromStatus = existing.subscriptionStatus;
    let toStatus = fromStatus;
    let newTrialEndsAt = existing.trialEndsAt;
    let newPlanKey = existing.planKey;
    // Cleared (never carried forward) on assign_plan below — a fresh plan
    // assignment always means "charge today's catalog price," never "keep
    // whatever lock happened to be sitting on this row." See
    // src/lib/plans.ts's getEffectivePlan() and the schema comment on
    // restaurants.lockedMonthlyPriceInPaisa.
    let newLockedMonthlyPriceInPaisa: number | null | undefined = undefined;
    let eventType: string;

    switch (body.action) {
      case "extend_trial": {
        const base = existing.trialEndsAt && existing.trialEndsAt.getTime() > Date.now()
          ? existing.trialEndsAt
          : new Date();
        newTrialEndsAt = new Date(base.getTime() + body.days * 24 * 60 * 60 * 1000);
        // Extending implies staying (or returning to) trialing — a lapsed
        // trial an admin extends as a goodwill gesture should un-expire.
        toStatus = "trialing";
        eventType = "trial_extended";
        break;
      }
      case "assign_plan": {
        newPlanKey = body.planKey;
        newLockedMonthlyPriceInPaisa = null;
        toStatus = body.activate ? "active" : fromStatus;
        eventType = body.activate ? "activated" : "plan_assigned";
        break;
      }
      case "mark_past_due": {
        toStatus = "past_due";
        eventType = "past_due_marked";
        break;
      }
      case "cancel": {
        toStatus = "cancelled";
        eventType = "cancelled";
        break;
      }
      case "reactivate": {
        toStatus = "active";
        eventType = "reactivated";
        break;
      }
    }

    const [updated] = await db.transaction(async (tx) => {
      const rows = await tx
        .update(restaurants)
        .set({
          subscriptionStatus: toStatus,
          trialEndsAt: newTrialEndsAt,
          planKey: newPlanKey,
          // Only assign_plan sets this (to null); every other action
          // leaves it as `undefined`, which Drizzle's .set() treats as
          // "don't touch this column" — never coerced into a NULL write.
          ...(newLockedMonthlyPriceInPaisa !== undefined
            ? { lockedMonthlyPriceInPaisa: newLockedMonthlyPriceInPaisa }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(restaurants.id, restaurantId))
        .returning({
          subscriptionStatus: restaurants.subscriptionStatus,
          trialEndsAt: restaurants.trialEndsAt,
          planKey: restaurants.planKey,
        });

      await recordSubscriptionEvent(tx, {
        restaurantId,
        eventType: eventType as Parameters<typeof recordSubscriptionEvent>[1]["eventType"],
        fromStatus,
        toStatus,
        planKey: newPlanKey,
        note: body.note ?? null,
        performedByUserId: session.user.id,
      });

      return rows;
    });

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "admin.subscription_action",
      resourceType: "restaurant",
      resourceId: restaurantId,
      ipAddress: getClientIp(request),
      metadata: { action: body.action, fromStatus, toStatus, planKey: newPlanKey },
    });

    return NextResponse.json({ restaurant: updated });
  } catch (err) {
    return toErrorResponse(err);
  }
}
