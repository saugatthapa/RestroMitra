import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { accountingPeriods } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { reopenAccountingPeriodSchema } from "@/lib/validation/accounting";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { HttpError } from "@/lib/http-error";

/**
 * PATCH ?action=close|reopen — the same close/reopen trust split as Cash
 * Register (MANAGE_CASH_REGISTER vs CORRECT_CASH_REGISTER): closing a
 * period is the routine day-to-day action (MANAGE_ACCOUNTING), reopening
 * one that's already closed needs the higher-trust
 * REOPEN_ACCOUNTING_PERIOD permission, same as postVoucher()'s own
 * allowClosedPeriod flag.
 */
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ slug: string; periodId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, periodId } = await ctx.params;
    const url = new URL(request.url);
    const action = url.searchParams.get("action");
    if (action !== "close" && action !== "reopen") {
      throw new HttpError('Query param "action" must be "close" or "reopen".', 400);
    }

    const permission =
      action === "reopen" ? PERMISSIONS.REOPEN_ACCOUNTING_PERIOD : PERMISSIONS.MANAGE_ACCOUNTING;
    const { session, restaurantId } = await resolveRestaurantContext(slug, permission);

    const [existing] = await db
      .select()
      .from(accountingPeriods)
      .where(and(eq(accountingPeriods.id, periodId), eq(accountingPeriods.restaurantId, restaurantId)))
      .limit(1);
    if (!existing) {
      return NextResponse.json({ error: "Period not found." }, { status: 404 });
    }

    let updated;
    if (action === "close") {
      if (existing.status === "closed") {
        throw new HttpError("This period is already closed.", 409);
      }
      [updated] = await db
        .update(accountingPeriods)
        .set({
          status: "closed",
          closedByUserId: session.user.id,
          closedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(accountingPeriods.id, periodId))
        .returning();
    } else {
      if (existing.status !== "closed") {
        throw new HttpError("Only a closed period can be reopened.", 409);
      }
      const parsed = await parseJsonBody(request, reopenAccountingPeriodSchema);
      if (!parsed.ok) return parsed.response;
      [updated] = await db
        .update(accountingPeriods)
        .set({
          status: "reopened",
          reopenedByUserId: session.user.id,
          reopenedAt: new Date(),
          reopenReason: parsed.data.reason,
          updatedAt: new Date(),
        })
        .where(eq(accountingPeriods.id, periodId))
        .returning();
    }

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: action === "close" ? "accounting.period_closed" : "accounting.period_reopened",
      resourceType: "accounting_period",
      resourceId: periodId,
      ipAddress: getClientIp(request),
    });

    return NextResponse.json({ period: updated });
  } catch (err) {
    return toErrorResponse(err);
  }
}
