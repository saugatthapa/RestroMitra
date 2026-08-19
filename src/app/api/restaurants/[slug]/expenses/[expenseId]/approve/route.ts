import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { expenses } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { canTransitionExpenseStatus } from "@/lib/finance/expense-status";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { HttpError } from "@/lib/http-error";

/**
 * pending_approval -> approved. Does NOT touch the ledger — an approved
 * expense is a commitment, not yet a cash movement (see the /pay route,
 * which is the only place a debit gets recorded). Compare-and-swap on
 * status = 'pending_approval' so two concurrent approvals can't both
 * succeed.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string; expenseId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, expenseId } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.APPROVE_EXPENSE,
    );

    const existing = await db.query.expenses.findFirst({
      where: and(eq(expenses.id, expenseId), eq(expenses.restaurantId, restaurantId)),
    });
    if (!existing) {
      return NextResponse.json({ error: "Expense not found." }, { status: 404 });
    }
    if (!canTransitionExpenseStatus(existing.status, "approved")) {
      throw new HttpError(`This expense is "${existing.status}" and can't be approved from there.`);
    }

    const [updated] = await db
      .update(expenses)
      .set({
        status: "approved",
        approvedByUserId: session.user.id,
        approvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(expenses.id, expenseId),
          eq(expenses.restaurantId, restaurantId),
          eq(expenses.status, "pending_approval"),
        ),
      )
      .returning();

    if (!updated) {
      throw new HttpError("This expense was just updated by someone else. Please refresh.", 409);
    }

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "expense.approved",
      resourceType: "expense",
      resourceId: expenseId,
      ipAddress: getClientIp(request),
      metadata: {},
    });

    return NextResponse.json({ expense: updated });
  } catch (err) {
    return toErrorResponse(err);
  }
}
