import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { restaurants } from "@/db/schema";
import { requirePlatformPermission } from "@/lib/rbac/guard";
import { PLATFORM_PERMISSIONS } from "@/lib/rbac/platform-permissions";
import { parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { adminTenantSuspensionSchema } from "@/lib/validation/subscription";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Platform Control Center (Phase 2) — suspend/reactivate a tenant.
 * Reversible and data-preserving: this only flips restaurants.isActive
 * (already gating public QR/website surfaces, now also gating
 * /dashboard and every tenant-scoped API route via guard.ts's
 * requireRestaurantActive) — nothing is deleted, archived, or
 * irreversibly changed. Deliberately separate from the subscription
 * action route: suspension is a platform-ops/policy decision, not a
 * billing state change, and always requires a stated reason.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ restaurantId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const session = await requirePlatformPermission(PLATFORM_PERMISSIONS.MANAGE_TENANTS);
    const { restaurantId } = await ctx.params;

    const [existing] = await db
      .select({ isActive: restaurants.isActive, name: restaurants.name })
      .from(restaurants)
      .where(eq(restaurants.id, restaurantId))
      .limit(1);
    if (!existing) {
      return NextResponse.json({ error: "Restaurant not found." }, { status: 404 });
    }

    const parsed = await parseJsonBody(request, adminTenantSuspensionSchema);
    if (!parsed.ok) return parsed.response;
    const { action, reason } = parsed.data;

    const targetActive = action === "reactivate";
    if (existing.isActive === targetActive) {
      return NextResponse.json(
        { error: `This restaurant is already ${targetActive ? "active" : "suspended"}.` },
        { status: 409 },
      );
    }

    const [updated] = await db
      .update(restaurants)
      .set({ isActive: targetActive, updatedAt: new Date() })
      .where(eq(restaurants.id, restaurantId))
      .returning({ isActive: restaurants.isActive });

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: action === "suspend" ? "admin.tenant_suspended" : "admin.tenant_reactivated",
      resourceType: "restaurant",
      resourceId: restaurantId,
      ipAddress: getClientIp(request),
      metadata: { reason },
    });

    return NextResponse.json({ restaurant: { isActive: updated.isActive } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
