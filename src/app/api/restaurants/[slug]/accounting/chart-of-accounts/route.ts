import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { chartOfAccounts } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccessForNullableTarget } from "@/lib/rbac/guard";
import { createAccountSchema } from "@/lib/validation/accounting";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { HttpError } from "@/lib/http-error";
import { isUniqueViolation } from "@/lib/db-error";

/**
 * Chart of Accounts — Phase 1 of the double-entry accounting module. See
 * ACCOUNTING_MODULE_PLAN.md. Reading the list only needs MANAGE_ACCOUNTING
 * (same single-permission-gates-both-read-and-write shape as
 * MANAGE_ACCOUNT_BOOKS) since there's no lower-trust "can view but not
 * edit" role carved out for this specialized module yet.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_ACCOUNTING);

    const rows = await db
      .select()
      .from(chartOfAccounts)
      .where(eq(chartOfAccounts.restaurantId, restaurantId))
      .orderBy(asc(chartOfAccounts.code));

    return NextResponse.json({ accounts: rows });
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
    const {
      session,
      restaurantId,
      role,
      branchId: grantedBranchId,
    } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_ACCOUNTING);

    const parsed = await parseJsonBody(request, createAccountSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    await requireBranchAccessForNullableTarget(session.user.id, restaurantId, data.branchId ?? null, {
      role,
      branchId: grantedBranchId,
    });

    if (data.parentAccountId) {
      const [parent] = await db
        .select({ id: chartOfAccounts.id })
        .from(chartOfAccounts)
        .where(eq(chartOfAccounts.id, data.parentAccountId))
        .limit(1);
      if (!parent) {
        return NextResponse.json({ error: "Parent account not found." }, { status: 400 });
      }
    }

    let account;
    try {
      [account] = await db
        .insert(chartOfAccounts)
        .values({
          restaurantId,
          branchId: data.branchId ?? null,
          code: data.code,
          name: data.name,
          type: data.type,
          normalBalance: data.normalBalance,
          parentAccountId: data.parentAccountId ?? null,
          description: data.description || null,
          isSystemAccount: false,
        })
        .returning();
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new HttpError("An account with this code already exists.", 409);
      }
      throw err;
    }

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "accounting.account_created",
      resourceType: "chart_of_accounts",
      resourceId: account.id,
      ipAddress: getClientIp(request),
      metadata: { code: account.code, name: account.name, type: account.type },
    });

    return NextResponse.json({ account }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
