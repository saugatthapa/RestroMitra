import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { expenseCategories } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { createExpenseCategorySchema } from "@/lib/validation/expense-categories";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { HttpError } from "@/lib/http-error";
import { isUniqueViolation } from "@/lib/db-error";

/**
 * Any role that can touch expenses at all (create a request, approve, or
 * pay) needs to see the category list to submit/file one against — so
 * GET only requires being able to reach the Expenses page in some
 * capacity, not full MANAGE_EXPENSES. Creating/renaming a category is the
 * more trusted action (MANAGE_EXPENSES), matching the spec's "authorized
 * restaurant owners" language — owner always has this; manager/accountant
 * do too via MANAGE_EXPENSES.
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug);

    const rows = await db
      .select()
      .from(expenseCategories)
      .where(eq(expenseCategories.restaurantId, restaurantId))
      .orderBy(asc(expenseCategories.sortOrder), asc(expenseCategories.name));

    return NextResponse.json({ categories: rows });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_EXPENSES,
    );

    const parsed = await parseJsonBody(request, createExpenseCategorySchema);
    if (!parsed.ok) return parsed.response;

    let category;
    try {
      [category] = await db
        .insert(expenseCategories)
        .values({ restaurantId, name: parsed.data.name })
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
      action: "expense_category.created",
      resourceType: "expense_category",
      resourceId: category.id,
      ipAddress: getClientIp(request),
      metadata: { name: category.name },
    });

    return NextResponse.json({ category }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
