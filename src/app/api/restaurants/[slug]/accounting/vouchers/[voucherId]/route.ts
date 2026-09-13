import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { accountingVouchers, accountingVoucherLines, chartOfAccounts } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";

/** Voucher detail with its lines, each joined to its account's code/name for display. */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ slug: string; voucherId: string }> },
) {
  try {
    const { slug, voucherId } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_ACCOUNTING);

    const [voucher] = await db
      .select()
      .from(accountingVouchers)
      .where(and(eq(accountingVouchers.id, voucherId), eq(accountingVouchers.restaurantId, restaurantId)))
      .limit(1);
    if (!voucher) {
      return NextResponse.json({ error: "Voucher not found." }, { status: 404 });
    }

    const lines = await db
      .select({
        id: accountingVoucherLines.id,
        accountId: accountingVoucherLines.accountId,
        accountCode: chartOfAccounts.code,
        accountName: chartOfAccounts.name,
        debitInPaisa: accountingVoucherLines.debitInPaisa,
        creditInPaisa: accountingVoucherLines.creditInPaisa,
        description: accountingVoucherLines.description,
        customerId: accountingVoucherLines.customerId,
        supplierId: accountingVoucherLines.supplierId,
        orderId: accountingVoucherLines.orderId,
      })
      .from(accountingVoucherLines)
      .innerJoin(chartOfAccounts, eq(chartOfAccounts.id, accountingVoucherLines.accountId))
      .where(eq(accountingVoucherLines.voucherId, voucherId));

    return NextResponse.json({ voucher, lines });
  } catch (err) {
    return toErrorResponse(err);
  }
}
