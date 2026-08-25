import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { orders } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { requireAnyPermission, requireBranchAccess } from "@/lib/rbac/guard";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { updateOrderStatusSchema } from "@/lib/validation/orders";
import { canTransition, type OrderStatus } from "@/lib/order-status";
import { isKitchenTransition } from "@/lib/kds";
import { deductRecipeStockForOrder } from "@/lib/inventory";
import { recordOrderCompletionLoyalty } from "@/lib/loyalty";
import { assignKotSequence } from "@/lib/kot";
import { recordSalesLedgerEntry } from "@/lib/ledger";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { syncTableStatusFromOrders } from "@/lib/tables";
import { publishEvent } from "@/lib/realtime";
import { recordOrderStatusHistory } from "@/lib/order-status-history";

/**
 * Advances (or cancels) an order's status. This is the one place the order
 * lifecycle actually moves — every status change, from any staff surface
 * (this generic board, KDS, POS), goes through canTransition() so an
 * illegal jump (e.g. "pending" straight to "completed") is rejected with a
 * clear 400 rather than silently accepted.
 *
 * Permission split: cancelling requires CANCEL_ORDER (manager/owner only by
 * default — see DEFAULT_ROLE_PERMISSIONS). The two kitchen-driven
 * transitions (confirmed->preparing, preparing->ready — see
 * isKitchenTransition in src/lib/kds.ts) accept EITHER the broader
 * EDIT_ORDER (cashier/waiter/manager/owner) OR the narrower
 * UPDATE_KDS_STATUS (kitchen_staff) — either is sufficient. Every other
 * transition (accepting a new order, serving a ready one) requires
 * EDIT_ORDER only; kitchen_staff holding just UPDATE_KDS_STATUS can't take
 * those actions. Checked against the REQUESTED target, not the order's
 * current status, so the permission error a caller sees matches the action
 * they attempted.
 */
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ slug: string; orderId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, orderId } = await ctx.params;
    const { session, restaurantId, role, branchId: grantedBranchId, timezone } = await resolveRestaurantContext(slug);

    const parsed = await parseJsonBody(request, updateOrderStatusSchema);
    if (!parsed.ok) return parsed.response;
    const targetStatus: OrderStatus = parsed.data.status;

    const rows = await db
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.restaurantId, restaurantId)))
      .limit(1);
    const existing = rows[0];
    if (!existing) {
      return NextResponse.json({ error: "Order not found." }, { status: 404 });
    }
    const currentStatus = existing.status as OrderStatus;

    // QA hardening pass: this was missing branch scoping entirely — a
    // branch-scoped waiter/kitchen_staff grant (enforced on order
    // creation, see orders/route.ts) could cancel or advance an order
    // belonging to a DIFFERENT branch of the same restaurant. An
    // unrestricted owner/manager/platform_admin grant (branchId === null)
    // still passes through untouched.
    // Perf: pass the grant resolveRestaurantContext already fetched above
    // instead of re-deriving it twice more (once per call below) — see
    // guard.ts's requireBranchAccess/requireAnyPermission doc comments.
    await requireBranchAccess(session.user.id, restaurantId, existing.branchId, {
      role,
      branchId: grantedBranchId,
    });

    const allowedPermissions =
      targetStatus === "cancelled"
        ? [PERMISSIONS.CANCEL_ORDER]
        : isKitchenTransition(currentStatus, targetStatus)
          ? [PERMISSIONS.EDIT_ORDER, PERMISSIONS.UPDATE_KDS_STATUS]
          : [PERMISSIONS.EDIT_ORDER];
    await requireAnyPermission(session.user.id, restaurantId, allowedPermissions, role);

    if (!canTransition(currentStatus, targetStatus)) {
      return NextResponse.json(
        {
          error: `Cannot move an order from "${currentStatus}" to "${targetStatus}".`,
        },
        { status: 400 },
      );
    }

    // confirmed -> preparing is the single point where recipe ingredients
    // are deducted from stock — see deductRecipeStockForOrder's own
    // comment for why this transition is naturally idempotent (the order
    // status state machine never allows preparing -> confirmed, so this
    // block can only ever run once per order). The status update and the
    // stock deduction commit together: if the deduction fails (e.g. a
    // corrupt recipe referencing a deleted inventory item), the status
    // change is rolled back too rather than silently advancing the order
    // with stock left un-deducted.
    //
    // The UPDATE's WHERE clause includes `status = currentStatus` (QA
    // hardening pass) — a compare-and-swap on the status column. Without
    // it, two concurrent PATCH requests both authorized against the same
    // stale `currentStatus` (read outside this transaction, above) would
    // BOTH match and BOTH commit, double-firing whatever side effect is
    // tied to this transition (double stock deduction, double loyalty
    // points), or letting a concurrent cancel be silently overwritten by
    // whichever request's UPDATE commits last. With the extra condition,
    // Postgres serializes the two UPDATEs on this row; the second one's
    // WHERE clause no longer matches once the first has committed (the
    // status is no longer `currentStatus`), so it returns zero rows and
    // this route reports a conflict instead of running its side effects a
    // second time.
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(orders)
        .set({ status: targetStatus, updatedAt: new Date() })
        .where(
          and(
            eq(orders.id, orderId),
            eq(orders.restaurantId, restaurantId),
            eq(orders.status, currentStatus),
          ),
        )
        .returning();

      if (!row) return null;

      // Commercial Launch Phase B.1 — the durable, structured record of
      // this transition (see order-status-history.ts's own doc comment for
      // why this exists alongside the audit log written after this
      // transaction commits, below).
      await recordOrderStatusHistory(tx, {
        restaurantId,
        orderId,
        fromStatus: currentStatus,
        toStatus: targetStatus,
        changedByUserId: session.user.id,
        reason: parsed.data.reason ?? null,
      });

      // pending -> confirmed is the single point a Kitchen Order Ticket is
      // cut — the moment front-of-house accepts the order into the kitchen
      // queue, matching KDS_VISIBLE_STATUSES (src/lib/kds.ts) starting at
      // "confirmed". Same once-per-order idempotency argument as the
      // recipe deduction below: the state machine never allows a
      // transition back to "pending", so this can only fire once per
      // order. The ticket NUMBER is assigned here, server-side, so it's
      // reliable regardless of which UI surface (Orders board, order
      // detail, POS) triggered the confirm; the client separately opens
      // the ticket page to actually trigger the browser print dialog (see
      // openKotTicket in kot-print-client.ts) — a web app can't silently
      // print to a physical printer without that.
      if (currentStatus === "pending" && targetStatus === "confirmed") {
        const kot = await assignKotSequence(tx, { restaurantId, orderId, timezone });
        row.kotSequence = kot.sequence;
        row.kotPrintedAt = kot.printedAt;
      }

      if (currentStatus === "confirmed" && targetStatus === "preparing") {
        await deductRecipeStockForOrder(tx, {
          restaurantId,
          branchId: row.branchId,
          orderId,
          recordedByUserId: session.user.id,
        });
      }

      // ->completed is the single point where loyalty points are awarded —
      // same idempotency argument as the stock deduction above: the status
      // state machine never allows a transition back out of "completed", so
      // this can only ever fire once per order. Only orders linked to a CRM
      // customer (Phase 8b, staff/POS orders only) earn points; walk-in
      // orders with no customerId are skipped (recordOrderCompletionLoyalty
      // itself no-ops when there's no customer, but checking row.customerId
      // here avoids the extra query entirely for the common no-customer case).
      if (targetStatus === "completed" && row.customerId) {
        await recordOrderCompletionLoyalty(tx, {
          restaurantId,
          customerId: row.customerId,
          orderId,
          totalInPaisa: row.totalInPaisa,
          timezone,
          recordedByUserId: session.user.id,
        });
      }

      // ->completed is also the single point a sale is booked into
      // Account Books — every completed order books one, regardless of
      // whether it's linked to a CRM customer (unlike the loyalty points
      // above, which only make sense for a known customer). Same
      // once-per-order idempotency argument.
      if (targetStatus === "completed") {
        await recordSalesLedgerEntry(tx, {
          restaurantId,
          orderId,
          orderNumber: row.orderNumber,
          totalInPaisa: row.totalInPaisa,
          paymentStatus: row.paymentStatus,
          customerName: row.customerName,
          timezone,
          recordedByUserId: session.user.id,
          // Commercial Launch Phase B.5 — Customer Credit. When this order
          // is linked to a CRM customer, link the ledger entry too — an
          // order that finishes unpaid/partially paid automatically joins
          // that customer's own tab (see ledger.ts's Customer Credit
          // section), no extra staff action required.
          customerId: row.customerId,
        });
      }

      // Recompute the table's derived status now that this order's status
      // has moved — e.g. the last kitchen-active order on a table going
      // ->served flips the table to payment_pending, or ->completed flips a
      // now-empty table to cleaning. See syncTableStatusFromOrders's own
      // comment for why this is a no-op for takeaway orders (null tableId)
      // and for out_of_service tables.
      await syncTableStatusFromOrders(tx, row.tableId);

      return row;
    });

    if (!updated) {
      return NextResponse.json(
        {
          error:
            "This order's status was just changed by someone else. Please refresh and try again.",
        },
        { status: 409 },
      );
    }

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "order.status_changed",
      resourceType: "order",
      resourceId: orderId,
      ipAddress: getClientIp(request),
      metadata: {
        from: currentStatus,
        to: targetStatus,
        reason: parsed.data.reason ?? null,
      },
    });

    await publishEvent(db, {
      restaurantId,
      branchId: updated.branchId,
      type: "order.status_changed",
      payload: {
        orderId: updated.id,
        orderNumber: updated.orderNumber,
        tableId: updated.tableId,
        from: currentStatus,
        to: targetStatus,
      },
    });

    return NextResponse.json({ order: updated });
  } catch (err) {
    return toErrorResponse(err);
  }
}
