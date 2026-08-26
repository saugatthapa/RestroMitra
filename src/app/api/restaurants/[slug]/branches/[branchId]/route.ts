import { NextResponse } from "next/server";
import { and, count, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { branches } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { updateBranchSchema } from "@/lib/validation/branches";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Edits a branch's details, or deactivates/reactivates it. Two guardrails
 * that keep the "every restaurant always has a working home base"
 * invariant intact: the main branch (created at onboarding) can never be
 * deactivated, and a restaurant can never be left with zero active
 * branches — both would otherwise strand every branch-scoped table/order/
 * staff grant that route through it.
 */
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ slug: string; branchId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, branchId } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_BRANCHES,
    );

    const [existing] = await db
      .select()
      .from(branches)
      .where(and(eq(branches.id, branchId), eq(branches.restaurantId, restaurantId)))
      .limit(1);
    if (!existing) {
      return NextResponse.json({ error: "Branch not found." }, { status: 404 });
    }

    const parsed = await parseJsonBody(request, updateBranchSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    if (data.isActive === false) {
      if (existing.isMain) {
        return NextResponse.json(
          { error: "The main branch can't be deactivated." },
          { status: 400 },
        );
      }
      const [activeCountRow] = await db
        .select({ n: count() })
        .from(branches)
        .where(
          and(
            eq(branches.restaurantId, restaurantId),
            eq(branches.isActive, true),
            ne(branches.id, branchId),
          ),
        );
      if ((activeCountRow?.n ?? 0) === 0) {
        return NextResponse.json(
          { error: "A restaurant needs at least one active branch." },
          { status: 400 },
        );
      }
    }

    const [updated] = await db
      .update(branches)
      .set({
        name: data.name ?? undefined,
        address: data.address !== undefined ? (data.address.length > 0 ? data.address : null) : undefined,
        city: data.city !== undefined ? (data.city.length > 0 ? data.city : null) : undefined,
        phone: data.phone !== undefined ? (data.phone.length > 0 ? data.phone : null) : undefined,
        isActive: data.isActive ?? undefined,
        updatedAt: new Date(),
      })
      // QA hardening pass (tenant-isolation audit) — every other query in
      // this route (and this codebase's convention generally) repeats the
      // restaurantId filter on every write, even when an earlier lookup
      // already proved ownership; this UPDATE was the one exception.
      .where(and(eq(branches.id, branchId), eq(branches.restaurantId, restaurantId)))
      .returning();

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "branches.updated",
      resourceType: "branch",
      resourceId: branchId,
      ipAddress: getClientIp(request),
      metadata: { changes: data },
    });

    return NextResponse.json({ branch: updated });
  } catch (err) {
    return toErrorResponse(err);
  }
}
