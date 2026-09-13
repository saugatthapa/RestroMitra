import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { accountingVouchers, accountMappings } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { postVoucher, AccountingError, type PostVoucherLine } from "@/lib/accounting/post-voucher";
import { MAPPING_KEYS } from "@/lib/accounting/account-mapping-keys";
import { createOpeningBalanceVoucherSchema } from "@/lib/validation/accounting";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Posts the ONE-TIME Opening Balance Voucher for the clean-cutover
 * migration strategy (ACCOUNTING_MODULE_PLAN.md Part 3, decision #1) — every
 * asset/liability/equity account's balance as of the cutover date, entered
 * by a human (an accountant reading it off the old Account Books reports),
 * with whatever the entered lines don't already net to zero absorbed by the
 * Opening Balance Equity plug account, per the posting matrix's §12. Old
 * `ledger_entries` history is never touched by this — it stays permanently
 * readable, exactly as the plan promised.
 *
 * Enforced as a true one-time action: a restaurant that already has an
 * opening_balance voucher gets a 409, not a silent replay — unlike an
 * automatic Phase 4 posting, a second cutover attempt with different
 * numbers is a mistake to catch loudly, not a retry to deduplicate.
 */
export async function POST(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug } = await ctx.params;
    const {
      session,
      restaurantId,
      role,
      branchId: grantedBranchId,
    } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_ACCOUNTING);

    const parsed = await parseJsonBody(request, createOpeningBalanceVoucherSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    await requireBranchAccess(session.user.id, restaurantId, data.branchId, {
      role,
      branchId: grantedBranchId,
    });

    const result = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: accountingVouchers.id, voucherNumber: accountingVouchers.voucherNumber })
        .from(accountingVouchers)
        .where(
          and(
            eq(accountingVouchers.restaurantId, restaurantId),
            eq(accountingVouchers.voucherType, "opening_balance"),
          ),
        )
        .limit(1);
      if (existing) {
        throw new AccountingError(
          `An Opening Balance Voucher already exists for this restaurant (${existing.voucherNumber}). ` +
            "Reverse it first if the cutover numbers need to change.",
          409,
        );
      }

      const [mapping] = await tx
        .select({ accountId: accountMappings.accountId })
        .from(accountMappings)
        .where(
          and(
            eq(accountMappings.restaurantId, restaurantId),
            eq(accountMappings.mappingKey, MAPPING_KEYS.OPENING_BALANCE_EQUITY),
          ),
        )
        .limit(1);
      if (!mapping) {
        throw new AccountingError(
          "No Opening Balance Equity account is mapped yet — run the default Chart of Accounts setup first.",
        );
      }

      const lines: PostVoucherLine[] = data.lines.map((line) => ({
        accountId: line.accountId,
        debitInPaisa: line.side === "debit" ? line.amount : undefined,
        creditInPaisa: line.side === "credit" ? line.amount : undefined,
        description: line.description || null,
        customerId: line.customerId ?? null,
        supplierId: line.supplierId ?? null,
      }));

      const totalDebit = lines.reduce((sum, l) => sum + (l.debitInPaisa ?? 0), 0);
      const totalCredit = lines.reduce((sum, l) => sum + (l.creditInPaisa ?? 0), 0);
      const imbalance = totalDebit - totalCredit;
      if (imbalance !== 0) {
        lines.push({
          accountId: mapping.accountId,
          // Plug goes on whichever side brings the voucher back into
          // balance — see this route's own doc comment.
          debitInPaisa: imbalance < 0 ? -imbalance : undefined,
          creditInPaisa: imbalance > 0 ? imbalance : undefined,
          description: "Opening balance plug",
        });
      }

      return postVoucher(tx, {
        restaurantId,
        branchId: data.branchId,
        voucherType: "opening_balance",
        voucherDate: data.voucherDate,
        narration: data.narration || "Opening balance — cutover to double-entry accounting",
        createdByUserId: session.user.id,
        lines,
        sourceType: "opening_balance_cutover",
        sourceId: restaurantId,
        postingEvent: "cutover",
      });
    });

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "accounting.opening_balance_posted",
      resourceType: "accounting_voucher",
      resourceId: result.voucher.id,
      ipAddress: getClientIp(request),
      metadata: { voucherNumber: result.voucher.voucherNumber },
    });

    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
