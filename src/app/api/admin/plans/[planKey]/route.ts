import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { plans } from "@/db/schema";
import { requirePlatformPermission } from "@/lib/rbac/guard";
import { PLATFORM_PERMISSIONS } from "@/lib/rbac/platform-permissions";
import { parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { updatePlanSchema } from "@/lib/validation/plans";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Edits an existing plan, including flipping isActive (retiring/
 * reinstating it — see getActivePlans() vs getAllPlansForAdmin() in
 * plans-db.ts for what that controls). No DELETE route: restaurants.
 * planKey is a real FK (RESTRICT, no cascade) and subscriptionEvents rows
 * reference plan keys historically — a plan is retired via isActive, never
 * deleted, the same "history stays" convention as staff/platform-role
 * revocation elsewhere in this app.
 */
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ planKey: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const session = await requirePlatformPermission(PLATFORM_PERMISSIONS.MANAGE_PLANS);
    const { planKey } = await ctx.params;

    const [existing] = await db.select().from(plans).where(eq(plans.key, planKey)).limit(1);
    if (!existing) {
      return NextResponse.json({ error: "Plan not found." }, { status: 404 });
    }

    const parsed = await parseJsonBody(request, updatePlanSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const [updated] = await db
      .update(plans)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(plans.key, planKey))
      .returning();

    await recordAuditLog({
      restaurantId: null,
      userId: session.user.id,
      action: "plan.updated",
      resourceType: "plan",
      resourceId: planKey,
      ipAddress: getClientIp(request),
      metadata: { key: planKey, changes: data },
    });

    // The marketing homepage and the POS-Nepal pillar page both render the
    // plan catalog with `export const revalidate = 3600` (ISR) — without
    // this, a platform admin toggling isActive (or changing a price) here
    // wouldn't show up on the live site for up to an hour, and the cache
    // header comment isn't obvious from the admin panel, so it silently
    // looks broken ("I turned it off but it's still showing"). Both are
    // pure marketing pages; revalidating on every plan write is cheap.
    revalidatePath("/");
    revalidatePath("/restaurant-pos-nepal");

    return NextResponse.json({ plan: updated });
  } catch (err) {
    return toErrorResponse(err);
  }
}
