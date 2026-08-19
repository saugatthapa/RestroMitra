import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { expenseCategories } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { updateExpenseCategorySchema } from "@/lib/validation/expense-categories";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { HttpError } from "@/lib/http-error";
import { isUniqueViolation } from "@/lib/db-error";

// No DELETE — a category referenced by any expense can't be removed
// (categoryId's FK is ON DELETE RESTRICT, on purpose: an expense must
// never end up with a dangling/nonsensical category). Deactivate it
// instead via PATCH { isActive: false } — same soft-delete pattern as
// menu categories/suppliers, hides it from new-expense pickers without
// touching history.
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ slug: string; categoryId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, categoryId } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_EXPENSES,
    );

    const existing = await db
      .select()
      .from(expenseCategories)
      .where(and(eq(expenseCategories.id, categoryId), eq(expenseCategories.restaurantId, restaurantId)))
      .limit(1);
    if (!existing[0]) {
      return NextResponse.json({ error: "Category not found." }, { status: 404 });
    }

    const parsed = await parseJsonBody(request, updateExpenseCategorySchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    let updated;
    try {
      [updated] = await db
        .update(expenseCategories)
        .set({
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(expenseCategories.id, categoryId), eq(expenseCategories.restaurantId, restaurantId)))
        .returning();
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new HttpError("A category with this name already exists.", 409);
      }
      throw err;
    }

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "expense_category.updated",
      resourceType: "expense_category",
      resourceId: categoryId,
      ipAddress: getClientIp(request),
      metadata: { fields: Object.keys(data) },
    });

    return NextResponse.json({ category: updated });
  } catch (err) {
    return toErrorResponse(err);
  }
}
