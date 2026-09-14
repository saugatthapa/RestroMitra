import { NextResponse } from "next/server";
import { db } from "@/db";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { createBankAccountSchema } from "@/lib/validation/accounting";
import { listBankAccounts, provisionBankAccount, ensureLegacyBankAccountsWrapped } from "@/lib/accounting/bank-accounts";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Phase 5, Slice 5b. Every GET first runs the legacy 1040/1045 auto-wrap
 * migration (see ensureLegacyBankAccountsWrapped's own doc comment) — it's
 * a no-op once this restaurant already has any bank_accounts row, so
 * running it on every visit rather than tracking a separate "have I done
 * this before" flag is simplest and correct.
 */
export async function GET(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_ACCOUNTING);

    await db.transaction((tx) =>
      ensureLegacyBankAccountsWrapped(tx, { restaurantId, wrappedByUserId: session.user.id }),
    );

    const accounts = await db.transaction((tx) => listBankAccounts(tx, restaurantId));
    return NextResponse.json({ bankAccounts: accounts });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_ACCOUNTING);

    const parsed = await parseJsonBody(request, createBankAccountSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const bankAccount = await db.transaction((tx) =>
      provisionBankAccount(tx, {
        restaurantId,
        bankName: data.bankName,
        accountNumber: data.accountNumber || null,
        branchName: data.branchName || null,
        notes: data.notes || null,
        createdByUserId: session.user.id,
      }),
    );

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "accounting.bank_account_created",
      resourceType: "bank_account",
      resourceId: bankAccount.id,
      ipAddress: getClientIp(request),
      metadata: { bankName: bankAccount.bankName, code: bankAccount.code },
    });

    return NextResponse.json({ bankAccount }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
