import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { expenses } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { rejectExpenseSchema } from "@/lib/validation/expenses";
import { canTransitionExpenseStatus } from "@/lib/finance/expense-status";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { HttpError } from "@/lib/http-error";

/** pending_approval -> rejected (terminal). Requires a reason — an
 * unexplained rejection isn't useful to the person who submitted it. */
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

    const parsed = await parseJsonBody(request, rejectExpenseSchema);
    if (!parsed.ok) return parsed.response;

    const existing = await db.query.expenses.findFirst({
      where: and(eq(expenses.id, expenseId), eq(expenses.restaurantId, restaurantId)),
    });
    if (!existing) {
      return NextResponse.json({ error: "Expense not found." }, { status: 404 });
    }
    if (!canTransitionExpenseStatus(existing.status, "rejected")) {
      throw new HttpError(`This expense is "${existing.status}" and can't be rejected from there.`);
    }

    const [updated] = await db
      .update(expenses)
      .set({
        status: "rejected",
        approvedByUserId: session.user.id,
        approvedAt: new Date(),
        rejectionReason: parsed.data.reason,
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
      action: "expense.rejected",
      resourceType: "expense",
      resourceId: expenseId,
      ipAddress: getClientIp(request),
      metadata: { reason: parsed.data.reason },
    });

    return NextResponse.json({ expense: updated });
  } catch (err) {
    return toErrorResponse(err);
  }
}
