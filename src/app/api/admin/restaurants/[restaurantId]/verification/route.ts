import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { restaurants } from "@/db/schema";
import { requirePlatformPermission } from "@/lib/rbac/guard";
import { PLATFORM_PERMISSIONS } from "@/lib/rbac/platform-permissions";
import { parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { adminTenantVerificationSchema } from "@/lib/validation/subscription";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Marks a restaurant verified (or reverts it to pending) — see
 * restaurants.verifiedAt's own schema comment for the feature this backs.
 * Same shape as the suspension route (src/app/api/admin/restaurants/
 * [restaurantId]/suspension) — one column, one FK, one audit log entry —
 * gated on the same MANAGE_TENANTS permission since it's the same
 * "edit tenant-level fields" capability.
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
      .select({ verifiedAt: restaurants.verifiedAt, name: restaurants.name })
      .from(restaurants)
      .where(eq(restaurants.id, restaurantId))
      .limit(1);
    if (!existing) {
      return NextResponse.json({ error: "Restaurant not found." }, { status: 404 });
    }

    const parsed = await parseJsonBody(request, adminTenantVerificationSchema);
    if (!parsed.ok) return parsed.response;
    const { action, note } = parsed.data;

    const targetVerified = action === "verify";
    if (Boolean(existing.verifiedAt) === targetVerified) {
      return NextResponse.json(
        { error: `This restaurant is already ${targetVerified ? "verified" : "pending"}.` },
        { status: 409 },
      );
    }

    const [updated] = await db
      .update(restaurants)
      .set({
        verifiedAt: targetVerified ? new Date() : null,
        verifiedByUserId: targetVerified ? session.user.id : null,
        updatedAt: new Date(),
      })
      .where(eq(restaurants.id, restaurantId))
      .returning({ verifiedAt: restaurants.verifiedAt });

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: action === "verify" ? "admin.tenant_verified" : "admin.tenant_verification_reset",
      resourceType: "restaurant",
      resourceId: restaurantId,
      ipAddress: getClientIp(request),
      metadata: note ? { note } : undefined,
    });

    return NextResponse.json({ restaurant: { verifiedAt: updated.verifiedAt } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
