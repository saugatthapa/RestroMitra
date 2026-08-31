import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { featureFlags } from "@/db/schema";
import { requirePlatformPermission } from "@/lib/rbac/guard";
import { PLATFORM_PERMISSIONS } from "@/lib/rbac/platform-permissions";
import { parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { updateFeatureFlagSchema } from "@/lib/validation/entitlements";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/** Edits an existing feature flag, including flipping defaultEnabled (the actual rollout lever — see the schema's own comment). No DELETE: a retired flag key is just left at defaultEnabled:false rather than removed, so any lingering reference to it (a stale per-tenant override, an old audit log entry) still resolves to something real. */
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ key: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const session = await requirePlatformPermission(PLATFORM_PERMISSIONS.MANAGE_ENTITLEMENTS);
    const { key } = await ctx.params;

    const [existing] = await db.select().from(featureFlags).where(eq(featureFlags.key, key)).limit(1);
    if (!existing) {
      return NextResponse.json({ error: "Feature flag not found." }, { status: 404 });
    }

    const parsed = await parseJsonBody(request, updateFeatureFlagSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const [updated] = await db
      .update(featureFlags)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(featureFlags.key, key))
      .returning();

    await recordAuditLog({
      restaurantId: null,
      userId: session.user.id,
      action: "feature_flag.updated",
      resourceType: "feature_flag",
      resourceId: key,
      ipAddress: getClientIp(request),
      metadata: { key, changes: data },
    });

    return NextResponse.json({ flag: updated });
  } catch (err) {
    return toErrorResponse(err);
  }
}
