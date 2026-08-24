import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { branches, dailyCloses } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { getMainBranch } from "@/lib/restaurant";
import { closeDailyBusinessSchema } from "@/lib/validation/daily-closing";
import { closeDailyBusiness } from "@/lib/daily-closing";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/** GET lists closed days (newest first) — the Daily Closing history view. */
export async function GET(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const { session, restaurantId, role, branchId: grantedBranchId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_DAILY_CLOSING,
    );

    const url = new URL(request.url);
    const requestedBranchId = url.searchParams.get("branchId");
    const effectiveBranchId = grantedBranchId ?? requestedBranchId;
    if (effectiveBranchId) {
      await requireBranchAccess(session.user.id, restaurantId, effectiveBranchId, {
        role,
        branchId: grantedBranchId,
      });
    }

    const rows = await db
      .select({
        id: dailyCloses.id,
        branchId: dailyCloses.branchId,
        businessDate: dailyCloses.businessDate,
        closedByUserId: dailyCloses.closedByUserId,
        closedAt: dailyCloses.closedAt,
        revenueInPaisa: dailyCloses.revenueInPaisa,
        cogsInPaisa: dailyCloses.cogsInPaisa,
        netProfitInPaisa: dailyCloses.netProfitInPaisa,
        cashVarianceInPaisa: dailyCloses.cashVarianceInPaisa,
        notes: dailyCloses.notes,
      })
      .from(dailyCloses)
      .where(
        effectiveBranchId
          ? and(eq(dailyCloses.restaurantId, restaurantId), eq(dailyCloses.branchId, effectiveBranchId))
          : eq(dailyCloses.restaurantId, restaurantId),
      )
      .orderBy(desc(dailyCloses.businessDate))
      .limit(90);

    return NextResponse.json({ dailyCloses: rows });
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
    const { session, restaurantId, role, timezone, branchId: grantedBranchId } =
      await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_DAILY_CLOSING);

    const parsed = await parseJsonBody(request, closeDailyBusinessSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    let branchId = data.branchId;
    if (branchId) {
      const owned = await db
        .select({ id: branches.id })
        .from(branches)
        .where(and(eq(branches.id, branchId), eq(branches.restaurantId, restaurantId)))
        .limit(1);
      if (owned.length === 0) {
        return NextResponse.json({ error: "Branch not found." }, { status: 404 });
      }
    } else if (grantedBranchId) {
      branchId = grantedBranchId;
    } else {
      const main = await getMainBranch(restaurantId);
      if (!main) {
        return NextResponse.json({ error: "This restaurant has no branch set up yet." }, { status: 400 });
      }
      branchId = main.id;
    }
    await requireBranchAccess(session.user.id, restaurantId, branchId, {
      role,
      branchId: grantedBranchId,
    });

    const dailyClose = await db.transaction((tx) =>
      closeDailyBusiness(tx, {
        restaurantId,
        branchId: branchId!,
        businessDate: data.businessDate,
        timezone,
        closedByUserId: session.user.id,
        notes: data.notes ?? null,
      }),
    );

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "daily_close.closed",
      resourceType: "daily_close",
      resourceId: dailyClose.id,
      ipAddress: getClientIp(request),
      metadata: {
        branchId,
        businessDate: data.businessDate,
        revenueInPaisa: dailyClose.revenueInPaisa,
        netProfitInPaisa: dailyClose.netProfitInPaisa,
        cashVarianceInPaisa: dailyClose.cashVarianceInPaisa,
      },
    });

    return NextResponse.json({ dailyClose }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
