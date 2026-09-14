import { NextResponse } from "next/server";
import { db } from "@/db";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { listActiveBankAccountsForPicker } from "@/lib/accounting/bank-accounts";

/**
 * Phase 5, Slice 5b — a minimal, redacted bank-account picker list for the
 * reconciliation "mark reconciled" action. Deliberately gated behind
 * MANAGE_ACCOUNT_BOOKS, not MANAGE_ACCOUNTING (see
 * listActiveBankAccountsForPicker's own doc comment): a manager can mark a
 * payment reconciled without holding the full accounting-manager
 * permission, so this needs its own lighter-weight, redacted read rather
 * than reusing the Bank Accounts admin screen's own GET route.
 */
export async function GET(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_ACCOUNT_BOOKS);

    const bankAccounts = await db.transaction((tx) => listActiveBankAccountsForPicker(tx, restaurantId));
    return NextResponse.json({ bankAccounts });
  } catch (err) {
    return toErrorResponse(err);
  }
}
