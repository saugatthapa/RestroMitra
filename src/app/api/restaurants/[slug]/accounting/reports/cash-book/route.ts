import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { getCashBookReport, listCashAndBankAccounts } from "@/lib/accounting/cash-book";
import { reportDateSchema } from "@/lib/validation/accounting";
import { restaurantDate } from "@/lib/restaurant-date";

/**
 * Phase 7, Slice 7a — Cash Book / Bank Book. Returns the picker's own
 * options (`accounts`) alongside the selected account's report in one
 * response, same "no second round-trip just to populate a dropdown"
 * convention Bank Reconciliation's own GET route already uses. `accountId`
 * defaults to the first available cash/bank account (by code) if omitted
 * or not one of this restaurant's own accounts — same "sensible default,
 * not an error" posture the rest of this module's reports use for dates.
 */
export async function GET(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId, timezone } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_ACCOUNTING);

    const accounts = await listCashAndBankAccounts(restaurantId);

    const url = new URL(request.url);
    const requestedAccountId = url.searchParams.get("accountId");
    const accountId =
      (requestedAccountId && accounts.some((a) => a.accountId === requestedAccountId) ? requestedAccountId : null) ??
      accounts[0]?.accountId ??
      null;

    const fromDateParam = url.searchParams.get("fromDate");
    const toDateParam = url.searchParams.get("toDate");
    const parsedFrom = fromDateParam ? reportDateSchema.safeParse(fromDateParam) : undefined;
    const parsedTo = toDateParam ? reportDateSchema.safeParse(toDateParam) : undefined;

    const toDate = parsedTo?.success ? parsedTo.data : restaurantDate(timezone);
    const fromDate = parsedFrom?.success ? parsedFrom.data : `${toDate.slice(0, 7)}-01`;

    const report = accountId
      ? await getCashBookReport({ restaurantId, accountId, fromDate, toDate })
      : null;

    return NextResponse.json({ accounts, report });
  } catch (err) {
    return toErrorResponse(err);
  }
}
