import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { featureFlags } from "@/db/schema";
import { requirePlatformPermission } from "@/lib/rbac/guard";
import { PLATFORM_PERMISSIONS } from "@/lib/rbac/platform-permissions";
import { parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { createFeatureFlagSchema } from "@/lib/validation/entitlements";
import { getAllFeatureFlags } from "@/lib/entitlements-db";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { rateLimit } from "@/lib/rate-limit";

/**
 * Platform Control Center (Phase 5) — global feature flags: a default
 * yes/no for a feature key not (or not only) governed by a restaurant's
 * plan. Gated MANAGE_ENTITLEMENTS for both read and write — unlike plans
 * (VIEW_TENANTS to read, MANAGE_PLANS to write), there's no separate
 * "view entitlements" permission in the platform catalog, and none of the
 * narrower default roles (support_admin/billing_admin/platform_viewer)
 * hold MANAGE_ENTITLEMENTS, so this stays full-access-tier only.
 */
export async function GET() {
  try {
    const session = await requirePlatformPermission(PLATFORM_PERMISSIONS.MANAGE_ENTITLEMENTS);

    // QA hardening (P2 backlog) — see ai-providers/route.ts's matching
    // comment; shares the same admin-read:user bucket.
    const limit = await rateLimit(`admin-read:user:${session.user.id}`, { limit: 120, windowMs: 60 * 1000 });
    if (!limit.allowed) {
      return NextResponse.json({ error: "Too many requests. Please wait a moment." }, { status: 429 });
    }

    const flags = await getAllFeatureFlags();
    return NextResponse.json({ flags });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const session = await requirePlatformPermission(PLATFORM_PERMISSIONS.MANAGE_ENTITLEMENTS);

    const parsed = await parseJsonBody(request, createFeatureFlagSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const existing = await db
      .select({ key: featureFlags.key })
      .from(featureFlags)
      .where(eq(featureFlags.key, data.key))
      .limit(1);
    if (existing.length > 0) {
      return NextResponse.json({ error: "A feature flag with this key already exists." }, { status: 409 });
    }

    const [flag] = await db
      .insert(featureFlags)
      .values({
        key: data.key,
        name: data.name,
        description: data.description,
        defaultEnabled: data.defaultEnabled,
      })
      .returning();

    await recordAuditLog({
      restaurantId: null,
      userId: session.user.id,
      action: "feature_flag.created",
      resourceType: "feature_flag",
      resourceId: flag.key,
      ipAddress: getClientIp(request),
      metadata: { key: flag.key, defaultEnabled: flag.defaultEnabled },
    });

    return NextResponse.json({ flag }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
