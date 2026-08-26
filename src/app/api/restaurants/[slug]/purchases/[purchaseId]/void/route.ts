import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { purchases } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { voidPurchaseSchema } from "@/lib/validation/inventory";
import { voidPurchase } from "@/lib/supplier-dues";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Voids a purchase — see voidPurchase's own doc comment in supplier-dues.ts
 * for exactly what is and isn't reversed (stock quantity + the linked
 * ledger due, but NOT the weighted-average cost impact, which isn't
 * generally reversible). Gated behind MANAGE_INVENTORY, same tier as
 * recording a purchase in the first place — voiding one is at least as
 * sensitive an action as creating one.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string; purchaseId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, purchaseId } = await ctx.params;
    const { session, restaurantId, role, branchId: grantedBranchId, timezone } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_INVENTORY,
    );

    const parsed = await parseJsonBody(request, voidPurchaseSchema);
    if (!parsed.ok) return parsed.response;

    const [existing] = await db
      .select({ id: purchases.id, branchId: purchases.branchId })
      .from(purchases)
      .where(and(eq(purchases.id, purchaseId), eq(purchases.restaurantId, restaurantId)))
      .limit(1);
    if (!existing) {
      return NextResponse.json({ error: "Purchase not found." }, { status: 404 });
    }
    // A branch-restricted caller can only void a purchase that belongs to
    // their own branch — same defense-in-depth pattern as
    // reports/summary/route.ts's branch scoping.
    await requireBranchAccess(session.user.id, restaurantId, existing.branchId, {
      role,
      branchId: grantedBranchId,
    });

    const result = await db.transaction((tx) =>
      voidPurchase(tx, {
        restaurantId,
        purchaseId,
        voidedByUserId: session.user.id,
        reason: parsed.data.reason,
        timezone,
        role,
      }),
    );

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "inventory.purchase.voided",
      resourceType: "purchase",
      resourceId: purchaseId,
      ipAddress: getClientIp(request),
      metadata: {
        reason: parsed.data.reason,
        reversedLineItemCount: result.reversedLineItemCount,
        costBasisNotReversed: true,
      },
    });

    return NextResponse.json({ purchase: result.purchase });
  } catch (err) {
    return toErrorResponse(err);
  }
}
