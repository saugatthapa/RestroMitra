import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { expenses, expenseCategories } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { payExpenseSchema } from "@/lib/validation/expenses";
import { canTransitionExpenseStatus } from "@/lib/finance/expense-status";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { recordExpenseLedgerEntry } from "@/lib/ledger";
import { HttpError } from "@/lib/http-error";

/**
 * approved -> paid. This is the ONLY place a non-owner/accountant flow's
 * expense actually creates its Account Books debit — matches the spec's
 * "never mark paid before confirmation": the money is only booked as
 * spent once someone with PAY_EXPENSE authority confirms it actually went
 * out, with a method attached. See EXPENSE_PAYMENT_METHODS' own doc
 * comment for why every method here is a manual confirmation, not a
 * provider-verified one — RestroMitra has no payout/disbursement API.
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
    const { session, restaurantId, timezone } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.PAY_EXPENSE,
    );

    const parsed = await parseJsonBody(request, payExpenseSchema);
    if (!parsed.ok) return parsed.response;

    const existing = await db.query.expenses.findFirst({
      where: and(eq(expenses.id, expenseId), eq(expenses.restaurantId, restaurantId)),
    });
    if (!existing) {
      return NextResponse.json({ error: "Expense not found." }, { status: 404 });
    }
    if (!canTransitionExpenseStatus(existing.status, "paid")) {
      throw new HttpError(`This expense is "${existing.status}" and can't be paid from there.`);
    }

    const category = await db.query.expenseCategories.findFirst({
      where: eq(expenseCategories.id, existing.categoryId),
    });

    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(expenses)
        .set({
          status: "paid",
          paymentMethod: parsed.data.paymentMethod,
          paidByUserId: session.user.id,
          paidAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(expenses.id, expenseId),
            eq(expenses.restaurantId, restaurantId),
            eq(expenses.status, "approved"),
          ),
        )
        .returning();

      if (!row) return null;

      await recordExpenseLedgerEntry(tx, {
        restaurantId,
        expenseId: row.id,
        amountInPaisa: row.amountInPaisa,
        categoryLabel: category?.name ?? "Expense",
        description: row.description,
        expenseDate: row.expenseDate,
        timezone,
        recordedByUserId: session.user.id,
      });

      return row;
    });

    if (!updated) {
      throw new HttpError("This expense was just updated by someone else. Please refresh.", 409);
    }

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "expense.paid",
      resourceType: "expense",
      resourceId: expenseId,
      ipAddress: getClientIp(request),
      metadata: { paymentMethod: parsed.data.paymentMethod, amountInPaisa: updated.amountInPaisa },
    });

    return NextResponse.json({ expense: updated });
  } catch (err) {
    return toErrorResponse(err);
  }
}
