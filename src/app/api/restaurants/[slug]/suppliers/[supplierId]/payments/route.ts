import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { branches, suppliers } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { recordSupplierPaymentSchema } from "@/lib/validation/supplier-statement";
import { recordSupplierPayment } from "@/lib/ledger";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { isAutomaticPostingEnabled } from "@/lib/accounting/automatic-posting";
import { postSupplierPaymentVoucher } from "@/lib/accounting/integrations/purchases";

/**
 * Records a lump-sum payment against a supplier's outstanding credit-
 * purchase dues, applied oldest-due-first (see recordSupplierPayment's own
 * doc comment in ledger.ts — mirrors settleCustomerCredit exactly). This is
 * the Supplier Statement page's own "record payment" action; the existing
 * per-purchase settle route (POST /ledger/[entryId]/settle, used by the
 * Supplier Dues report's per-row "Record payment" button) still works
 * unchanged for the rarer case of targeting one purchase specifically.
 *
 * Gated on MANAGE_ACCOUNT_BOOKS, same segregation of duties as every other
 * due-settlement route in this app (see the customer credit settle route's
 * own comment). A 409 here means someone else settled part of this
 * supplier's balance a moment ago; the client should refresh and re-check
 * before retrying.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string; supplierId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, supplierId } = await ctx.params;
    const { session, restaurantId, timezone } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_ACCOUNT_BOOKS,
    );

    const [supplier] = await db
      .select({ id: suppliers.id })
      .from(suppliers)
      .where(and(eq(suppliers.id, supplierId), eq(suppliers.restaurantId, restaurantId)))
      .limit(1);
    if (!supplier) {
      return NextResponse.json({ error: "Supplier not found." }, { status: 404 });
    }

    const parsed = await parseJsonBody(request, recordSupplierPaymentSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const result = await db.transaction(async (tx) => {
      const payment = await recordSupplierPayment(tx, {
        restaurantId,
        supplierId,
        amountInPaisa: data.amount,
        note: data.note || null,
        timezone,
        recordedByUserId: session.user.id,
      });

      // Accounting module Phase 4, Slice 4c — one voucher for the total
      // amount actually applied, per ACCOUNTING_PHASE_4_PLAN.md's own note
      // (this can settle several purchases' Accounts Payable in a single
      // call). This lump-sum payment isn't scoped to one purchase's branch
      // — it can pay down dues from purchases recorded at different
      // branches — so it's tagged to the restaurant's main branch, the same
      // pragmatic default every other restaurant-wide automatic posting in
      // this phase falls back to when the data model has no single "right"
      // branch to pick.
      if (await isAutomaticPostingEnabled(tx, restaurantId) && payment.settlements.length > 0) {
        const [mainBranch] = await tx
          .select({ id: branches.id })
          .from(branches)
          .where(and(eq(branches.restaurantId, restaurantId), eq(branches.isMain, true)))
          .limit(1);
        if (mainBranch) {
          await postSupplierPaymentVoucher(tx, {
            restaurantId,
            branchId: mainBranch.id,
            supplierId,
            firstSettlementEntryId: payment.settlements[0].settlementEntry.id,
            appliedInPaisa: payment.appliedInPaisa,
            timezone,
            createdByUserId: session.user.id,
          });
        }
      }

      return payment;
    });

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "supplier.payment_recorded",
      resourceType: "supplier",
      resourceId: supplierId,
      ipAddress: getClientIp(request),
      metadata: { appliedInPaisa: result.appliedInPaisa, entriesSettled: result.settlements.length },
    });

    return NextResponse.json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
