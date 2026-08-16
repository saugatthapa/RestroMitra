import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { expenses } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { updateExpenseSchema } from "@/lib/validation/expenses";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

async function getOwnedExpense(restaurantId: string, expenseId: string) {
  const rows = await db
    .select()
    .from(expenses)
    .where(and(eq(expenses.id, expenseId), eq(expenses.restaurantId, restaurantId)))
    .limit(1);
  return rows[0] ?? null;
}

// No DELETE endpoint — an expense entry is corrected via PATCH (fixing a
// typo'd amount/category/date) or voided via PATCH { isVoided: true }
// (soft delete, same pattern as suppliers/menu items), never hard-deleted
// — a wrong expense is still an audit trail of what was entered and when.
export async function PATCH(
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
      PERMISSIONS.MANAGE_EXPENSES,
    );

    const existing = await getOwnedExpense(restaurantId, expenseId);
    if (!existing) {
      return NextResponse.json({ error: "Expense not found." }, { status: 404 });
    }

    const parsed = await parseJsonBody(request, updateExpenseSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const [updated] = await db
      .update(expenses)
      .set({
        ...(data.category !== undefined ? { category: data.category } : {}),
        ...(data.amount !== undefined ? { amountInPaisa: data.amount } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.expenseDate !== undefined ? { expenseDate: data.expenseDate } : {}),
        ...(data.note !== undefined ? { note: data.note || null } : {}),
        ...(data.isVoided !== undefined ? { isVoided: data.isVoided } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(expenses.id, expenseId), eq(expenses.restaurantId, restaurantId)))
      .returning();

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "expense.updated",
      resourceType: "expense",
      resourceId: expenseId,
      ipAddress: getClientIp(request),
      metadata: { fields: Object.keys(data) },
    });

    return NextResponse.json({ expense: updated });
  } catch (err) {
    return toErrorResponse(err);
  }
}
