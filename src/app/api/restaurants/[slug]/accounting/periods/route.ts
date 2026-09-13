import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { accountingPeriods } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccessForNullableTarget } from "@/lib/rbac/guard";
import { createAccountingPeriodSchema } from "@/lib/validation/accounting";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { HttpError } from "@/lib/http-error";

export async function GET(_request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_ACCOUNTING);

    const rows = await db
      .select()
      .from(accountingPeriods)
      .where(eq(accountingPeriods.restaurantId, restaurantId))
      .orderBy(desc(accountingPeriods.periodStart));

    return NextResponse.json({ periods: rows });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Creates a period as "open" — periods are opt-in enforcement (see
 * post-voucher.ts's own comment: a restaurant with no period rows at all
 * simply isn't blocked from posting). Deliberately does not check for
 * overlap against existing periods in a DB constraint (hard to express
 * cleanly for a date-range column pair without a range type this schema
 * doesn't otherwise use) — the route checks in application code instead,
 * same "enforced in application code" convention as several other
 * invariants across this schema.
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

    const parsed = await parseJsonBody(request, createAccountingPeriodSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    if (new Date(data.periodEnd) < new Date(data.periodStart)) {
      throw new HttpError("Period end must be on or after period start.", 400);
    }

    await requireBranchAccessForNullableTarget(session.user.id, restaurantId, data.branchId ?? null, {
      role,
      branchId: grantedBranchId,
    });

    const existing = await db
      .select()
      .from(accountingPeriods)
      .where(eq(accountingPeriods.restaurantId, restaurantId));
    const overlaps = existing.some(
      (p) =>
        p.branchId === (data.branchId ?? null) &&
        data.periodStart <= p.periodEnd &&
        data.periodEnd >= p.periodStart,
    );
    if (overlaps) {
      throw new HttpError("This period overlaps an existing one for the same branch scope.", 409);
    }

    const [period] = await db
      .insert(accountingPeriods)
      .values({
        restaurantId,
        branchId: data.branchId ?? null,
        periodStart: data.periodStart,
        periodEnd: data.periodEnd,
        status: "open",
      })
      .returning();

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "accounting.period_created",
      resourceType: "accounting_period",
      resourceId: period.id,
      ipAddress: getClientIp(request),
      metadata: { periodStart: period.periodStart, periodEnd: period.periodEnd },
    });

    return NextResponse.json({ period }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
