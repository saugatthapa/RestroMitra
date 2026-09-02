import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { restaurants } from "@/db/schema";
import { requirePlatformPermission } from "@/lib/rbac/guard";
import { PLATFORM_PERMISSIONS } from "@/lib/rbac/platform-permissions";
import { parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { setEntitlementOverrideSchema, clearEntitlementOverrideSchema } from "@/lib/validation/entitlements";
import { explainTenantAccess, setEntitlementOverride, clearEntitlementOverride } from "@/lib/entitlements-db";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { rateLimit } from "@/lib/rate-limit";

/**
 * Platform Control Center (Phase 5) — the "explain this tenant's access"
 * screen's data source, plus the write path for setting/clearing a
 * per-tenant override. GET is VIEW_TENANTS (same read tier as the
 * restaurant detail route this is a tab of); POST/DELETE are
 * MANAGE_ENTITLEMENTS — a platform admin can SEE why a tenant has/doesn't
 * have a feature without being able to change it, same "view vs manage"
 * split as tenants/plans elsewhere in this console.
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ restaurantId: string }> },
) {
  try {
    const session = await requirePlatformPermission(PLATFORM_PERMISSIONS.VIEW_TENANTS);

    // QA hardening (P2 backlog) — see ai-providers/route.ts's matching
    // comment; shares the same admin-read:user bucket.
    const limit = await rateLimit(`admin-read:user:${session.user.id}`, { limit: 120, windowMs: 60 * 1000 });
    if (!limit.allowed) {
      return NextResponse.json({ error: "Too many requests. Please wait a moment." }, { status: 429 });
    }

    const { restaurantId } = await ctx.params;

    const [restaurant] = await db
      .select({ id: restaurants.id })
      .from(restaurants)
      .where(eq(restaurants.id, restaurantId))
      .limit(1);
    if (!restaurant) {
      return NextResponse.json({ error: "Restaurant not found." }, { status: 404 });
    }

    const entitlements = await explainTenantAccess(restaurantId);
    return NextResponse.json({ entitlements });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ restaurantId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const session = await requirePlatformPermission(PLATFORM_PERMISSIONS.MANAGE_ENTITLEMENTS);
    const { restaurantId } = await ctx.params;

    const [restaurant] = await db
      .select({ id: restaurants.id })
      .from(restaurants)
      .where(eq(restaurants.id, restaurantId))
      .limit(1);
    if (!restaurant) {
      return NextResponse.json({ error: "Restaurant not found." }, { status: 404 });
    }

    const parsed = await parseJsonBody(request, setEntitlementOverrideSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const override = await setEntitlementOverride({
      restaurantId,
      featureKey: data.featureKey,
      granted: data.granted,
      reason: data.reason,
      createdByUserId: session.user.id,
    });

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "entitlement_override.set",
      resourceType: "entitlement_override",
      resourceId: override.id,
      ipAddress: getClientIp(request),
      metadata: { featureKey: data.featureKey, granted: data.granted, reason: data.reason },
    });

    return NextResponse.json({ override }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ restaurantId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const session = await requirePlatformPermission(PLATFORM_PERMISSIONS.MANAGE_ENTITLEMENTS);
    const { restaurantId } = await ctx.params;

    const parsed = await parseJsonBody(request, clearEntitlementOverrideSchema);
    if (!parsed.ok) return parsed.response;
    const { featureKey } = parsed.data;

    await clearEntitlementOverride(restaurantId, featureKey);

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "entitlement_override.cleared",
      resourceType: "entitlement_override",
      resourceId: featureKey,
      ipAddress: getClientIp(request),
      metadata: { featureKey },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
