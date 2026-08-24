import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { branches, registerShifts } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { getMainBranch } from "@/lib/restaurant";
import { openRegisterShiftSchema } from "@/lib/validation/cash-register";
import { openRegisterShift } from "@/lib/cash-register";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * GET lists register shifts (newest first) — the history view behind the
 * Cash Register screen and an input to End-of-Day Closing. Branch-scoped
 * the same way tables/attendance are: a branch-locked grant only ever
 * sees its own branch; an unrestricted caller sees every branch by
 * default, or narrows via `?branchId=`.
 */
export async function GET(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const { session, restaurantId, role, branchId: grantedBranchId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_CASH_REGISTER,
    );

    const url = new URL(request.url);
    const requestedBranchId = url.searchParams.get("branchId");
    const statusFilter = url.searchParams.get("status");
    const effectiveBranchId = grantedBranchId ?? requestedBranchId;
    if (effectiveBranchId) {
      await requireBranchAccess(session.user.id, restaurantId, effectiveBranchId, {
        role,
        branchId: grantedBranchId,
      });
    }

    const conditions = [eq(registerShifts.restaurantId, restaurantId)];
    if (effectiveBranchId) conditions.push(eq(registerShifts.branchId, effectiveBranchId));
    if (statusFilter === "open" || statusFilter === "closed") {
      conditions.push(eq(registerShifts.status, statusFilter));
    }

    const rows = await db
      .select()
      .from(registerShifts)
      .where(and(...conditions))
      .orderBy(desc(registerShifts.openedAt))
      .limit(100);

    return NextResponse.json({ shifts: rows });
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
    const { session, restaurantId, role, branchId: grantedBranchId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_CASH_REGISTER,
    );

    const parsed = await parseJsonBody(request, openRegisterShiftSchema);
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
        return NextResponse.json(
          { error: "This restaurant has no branch set up yet." },
          { status: 400 },
        );
      }
      branchId = main.id;
    }

    await requireBranchAccess(session.user.id, restaurantId, branchId, {
      role,
      branchId: grantedBranchId,
    });

    const shift = await db.transaction((tx) =>
      openRegisterShift(tx, {
        restaurantId,
        branchId: branchId!,
        registerName: data.registerName ?? "Main Register",
        openedByUserId: session.user.id,
        openingCashInPaisa: data.openingCashInPaisa,
        openingNotes: data.openingNotes ?? null,
      }),
    );

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "register.opened",
      resourceType: "register_shift",
      resourceId: shift.id,
      ipAddress: getClientIp(request),
      metadata: {
        branchId,
        registerName: shift.registerName,
        openingCashInPaisa: shift.openingCashInPaisa,
      },
    });

    return NextResponse.json({ shift }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
