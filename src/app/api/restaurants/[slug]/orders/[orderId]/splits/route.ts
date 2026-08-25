import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { orders } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { replaceBillSplitsSchema } from "@/lib/validation/bill-splits";
import { replaceBillSplits, loadBillSplitSummary } from "@/lib/bill-splits";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { requireBranchAccess } from "@/lib/rbac/guard";

/**
 * Commercial Launch Phase B.9 — Split Bill. GET returns the order's
 * current shares (each with its assigned items) plus the computed money
 * summary (see computeBillSplitSummary in bill-splits.ts) — nothing here
 * is stored, it's recomputed fresh from the order's current items +
 * adjustments on every read, so it can never drift out of sync with a
 * later discount/service charge change. Ungated (any staff member with
 * restaurant access can view), same read/write split as the order detail
 * route itself — only the PUT below (actually redefining shares) is
 * permission-gated.
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ slug: string; orderId: string }> },
) {
  try {
    const { slug, orderId } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug);

    const { splits, summary } = await loadBillSplitSummary(db, { restaurantId, orderId });
    return NextResponse.json({ splits, summary });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Redefines an order's ENTIRE set of bill splits — whole-state-replace,
 * same convention as updateComboSchema's `items` and the adjustments
 * PATCH (see replaceBillSplitsSchema's own comment). Gated EDIT_ORDER,
 * same tier as recording a payment — splitting up a bill is ordinary order
 * handling, not the more privileged APPLY_DISCOUNT/REFUND_ORDER tier. The
 * actual validation + transactional write lives in replaceBillSplits
 * (bill-splits.ts), same "thin route, real logic in the lib" split as
 * tables.ts's transfer/merge/hold routes.
 *
 * Deleting the old split rows cascades (DB-level FK) to their
 * orderBillSplitItems automatically, and sets any payments.splitId that
 * pointed at them back to NULL (the payment itself survives — see that
 * column's own comment in schema.ts) — redefining splits untags any
 * payments recorded against the old share ids. This is a deliberate,
 * documented limitation: re-splitting a bill after payments were already
 * tagged loses the tag, not the money.
 */
export async function PUT(
  request: Request,
  ctx: { params: Promise<{ slug: string; orderId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, orderId } = await ctx.params;
    const { session, restaurantId, role, branchId: grantedBranchId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.EDIT_ORDER,
    );

    const parsed = await parseJsonBody(request, replaceBillSplitsSchema);
    if (!parsed.ok) return parsed.response;
    const { splits: requestedSplits } = parsed.data;

    // Unlocked pre-check for branch access, same two-read pattern as the
    // hold/transfer routes (see their own comments): a cheap read here so
    // requireBranchAccess never has to run inside — or hold open — the row
    // lock that replaceBillSplits itself takes.
    const existingRows = await db
      .select({ id: orders.id, branchId: orders.branchId })
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.restaurantId, restaurantId)))
      .limit(1);
    if (!existingRows[0]) {
      return NextResponse.json({ error: "Order not found." }, { status: 404 });
    }
    await requireBranchAccess(session.user.id, restaurantId, existingRows[0].branchId, {
      role,
      branchId: grantedBranchId,
    });

    const result = await db.transaction((tx) =>
      replaceBillSplits(tx, { restaurantId, orderId, splits: requestedSplits }),
    );

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "order.bill_split",
      resourceType: "order",
      resourceId: orderId,
      ipAddress: getClientIp(request),
      metadata: { shareCount: result.splits.length },
    });

    // Re-read post-write (not just echoed back) so the response's
    // `summary` reflects the actual committed state, same reasoning as
    // every other write route that returns a freshly-derived total rather
    // than trusting its own inputs.
    const { splits, summary } = await loadBillSplitSummary(db, { restaurantId, orderId });
    return NextResponse.json({ splits, summary }, { status: 200 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
