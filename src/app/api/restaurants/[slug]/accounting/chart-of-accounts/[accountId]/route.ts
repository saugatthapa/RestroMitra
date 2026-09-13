import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { accountMappings, chartOfAccounts } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { updateAccountSchema } from "@/lib/validation/accounting";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Edits a Chart of Accounts entry — rename, toggle active, or update the
 * description. Deliberately does NOT allow changing code/type/normalBalance
 * after creation (those define what the account IS to every voucher line
 * that already references it) or deleting a row at all — an account with
 * any posted voucher lines must never disappear, and even one with none
 * yet is simpler to just deactivate. isSystemAccount rows (the seeded
 * chart from ACCOUNTING_POLICY_AND_POSTING_MATRIX.md) can still be
 * deactivated here if a restaurant genuinely doesn't need one — but never
 * deleted, since that's not an operation this route exposes for ANY
 * account, system or not.
 */
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ slug: string; accountId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, accountId } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_ACCOUNTING,
    );

    const parsed = await parseJsonBody(request, updateAccountSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const [existing] = await db
      .select()
      .from(chartOfAccounts)
      .where(and(eq(chartOfAccounts.id, accountId), eq(chartOfAccounts.restaurantId, restaurantId)))
      .limit(1);
    if (!existing) {
      return NextResponse.json({ error: "Account not found." }, { status: 404 });
    }

    // Phase 4 hardening (ACCOUNTING_PHASE_4_PLAN.md 2.3) — once automatic
    // posting depends on account_mappings resolving to an ACTIVE account
    // (see resolveAccountMappings), deactivating a mapped account here
    // would silently start throwing on every future automatic posting that
    // needs it (a cash payment, a sale, ...). This account is not itself
    // aware of whether it's "load-bearing" — the mapping is what makes it
    // so — so the check has to happen here, at the one place an account
    // can be deactivated.
    if (data.isActive === false && existing.isActive) {
      const [activeMapping] = await db
        .select({ mappingKey: accountMappings.mappingKey })
        .from(accountMappings)
        .where(and(eq(accountMappings.restaurantId, restaurantId), eq(accountMappings.accountId, accountId)))
        .limit(1);
      if (activeMapping) {
        return NextResponse.json(
          {
            error: `This account is mapped to "${activeMapping.mappingKey}" and used by automatic posting — remap that first from the Chart of Accounts before deactivating it.`,
          },
          { status: 400 },
        );
      }
    }

    const [updated] = await db
      .update(chartOfAccounts)
      .set({
        name: data.name ?? existing.name,
        isActive: data.isActive ?? existing.isActive,
        description: data.description !== undefined ? data.description || null : existing.description,
        updatedAt: new Date(),
      })
      .where(eq(chartOfAccounts.id, accountId))
      .returning();

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "accounting.account_updated",
      resourceType: "chart_of_accounts",
      resourceId: accountId,
      ipAddress: getClientIp(request),
      metadata: { isActive: updated.isActive },
    });

    return NextResponse.json({ account: updated });
  } catch (err) {
    return toErrorResponse(err);
  }
}
