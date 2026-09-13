import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { branches, customers } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { settleCustomerCreditSchema } from "@/lib/validation/customers";
import { settleCustomerCredit } from "@/lib/ledger";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { isAutomaticPostingEnabled } from "@/lib/accounting/automatic-posting";
import { postCustomerCreditSettlementVoucher } from "@/lib/accounting/integrations/purchases";

/**
 * Commercial Launch Phase B.5 — Customer Credit. Records a lump-sum
 * payment against a customer's outstanding tab, applied oldest-charge-first
 * (see settleCustomerCredit's own doc comment in ledger.ts).
 *
 * Deliberately gated on MANAGE_ACCOUNT_BOOKS, NOT MANAGE_CUSTOMERS — same
 * segregation of duties Account Books' own due-settlement route already
 * enforces (a cashier can view/manage the CRM record and SEE a customer's
 * balance on their profile — see the customer GET route — but settling
 * money into the ledger is a financial-books action reserved for
 * manager/accountant/owner, exactly like every other due settlement in
 * this app). A 409 here (surfaced by settleCustomerCredit re-throwing
 * settleLedgerDue's own CAS failure) means someone else settled part of
 * this customer's balance a moment ago; the client should refresh and
 * re-check the outstanding amount before retrying.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string; customerId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, customerId } = await ctx.params;
    const { session, restaurantId, timezone } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_ACCOUNT_BOOKS,
    );

    const [customer] = await db
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.id, customerId), eq(customers.restaurantId, restaurantId)))
      .limit(1);
    if (!customer) {
      return NextResponse.json({ error: "Customer not found." }, { status: 404 });
    }

    const parsed = await parseJsonBody(request, settleCustomerCreditSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const result = await db.transaction(async (tx) => {
      const settlement = await settleCustomerCredit(tx, {
        restaurantId,
        customerId,
        amountInPaisa: data.amount,
        note: data.note || null,
        timezone,
        recordedByUserId: session.user.id,
      });

      // Accounting module Phase 4, Slice 4c — AR mirror of the supplier
      // lump-sum payment above; same "one voucher for the total applied,
      // tagged to the main branch" reasoning.
      if (await isAutomaticPostingEnabled(tx, restaurantId) && settlement.settlements.length > 0) {
        const [mainBranch] = await tx
          .select({ id: branches.id })
          .from(branches)
          .where(and(eq(branches.restaurantId, restaurantId), eq(branches.isMain, true)))
          .limit(1);
        if (mainBranch) {
          await postCustomerCreditSettlementVoucher(tx, {
            restaurantId,
            branchId: mainBranch.id,
            customerId,
            firstSettlementEntryId: settlement.settlements[0].settlementEntry.id,
            appliedInPaisa: settlement.appliedInPaisa,
            timezone,
            createdByUserId: session.user.id,
          });
        }
      }

      return settlement;
    });

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "customer.credit_settled",
      resourceType: "customer",
      resourceId: customerId,
      ipAddress: getClientIp(request),
      metadata: { appliedInPaisa: result.appliedInPaisa, entriesSettled: result.settlements.length },
    });

    return NextResponse.json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
