import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { settleLedgerDueSchema } from "@/lib/validation/ledger";
import { settleLedgerDue } from "@/lib/ledger";
import { db } from "@/db";
import { orders, purchases } from "@/db/schema";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { isAutomaticPostingEnabled } from "@/lib/accounting/automatic-posting";
import { postLedgerDueSettlementVoucher } from "@/lib/accounting/integrations/purchases";

/**
 * Settles all or part of an outstanding due — see settleLedgerDue's own
 * comment (ledger.ts) for the partial-settlement/compare-and-swap shape.
 * A 409 here means someone else settled this exact entry a moment ago;
 * the client should refresh and re-check the remaining balance.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string; entryId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, entryId } = await ctx.params;
    const { session, restaurantId, timezone } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_ACCOUNT_BOOKS,
    );

    const parsed = await parseJsonBody(request, settleLedgerDueSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const result = await db.transaction(async (tx) => {
      const settled = await settleLedgerDue(tx, {
        restaurantId,
        entryId,
        amountInPaisa: data.amount,
        note: data.note || null,
        timezone,
        recordedByUserId: session.user.id,
      });

      // Accounting module Phase 4, Slice 4c — this generic settle route
      // (per ACCOUNTING_PHASE_4_PLAN.md) is used for BOTH a supplier due
      // (referenceType "purchase") and a customer/order due (referenceType
      // "order") through the same settleLedgerDue call — see
      // postLedgerDueSettlementVoucher's own comment. Neither purchases nor
      // orders' branchId is on the ledger entry itself, so it's looked up
      // from whichever row the entry actually references.
      if (
        (await isAutomaticPostingEnabled(tx, restaurantId)) &&
        (settled.original.referenceType === "purchase" || settled.original.referenceType === "order")
      ) {
        const branchId =
          settled.original.referenceType === "purchase"
            ? (
                await tx
                  .select({ branchId: purchases.branchId })
                  .from(purchases)
                  .where(and(eq(purchases.id, settled.original.referenceId!), eq(purchases.restaurantId, restaurantId)))
                  .limit(1)
              )[0]?.branchId
            : (
                await tx
                  .select({ branchId: orders.branchId })
                  .from(orders)
                  .where(and(eq(orders.id, settled.original.referenceId!), eq(orders.restaurantId, restaurantId)))
                  .limit(1)
              )[0]?.branchId;

        // The referenced purchase/order row is expected to always exist
        // (referenceId is set at creation and never cleared) — but if it's
        // somehow gone, post nothing rather than crash a settlement that
        // has already legitimately happened on the Account Books side.
        if (branchId) {
          await postLedgerDueSettlementVoucher(tx, {
            restaurantId,
            branchId,
            referenceType: settled.original.referenceType,
            settlementEntryId: settled.settlementEntry.id,
            supplierId: settled.original.supplierId,
            customerId: settled.original.customerId,
            amountInPaisa: data.amount,
            timezone,
            createdByUserId: session.user.id,
          });
        }
      }

      return settled;
    });

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "ledger.due_settled",
      resourceType: "ledger_entry",
      resourceId: entryId,
      ipAddress: getClientIp(request),
      metadata: { amountInPaisa: data.amount },
    });

    return NextResponse.json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
