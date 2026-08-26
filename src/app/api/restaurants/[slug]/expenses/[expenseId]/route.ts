import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { expenses, expenseCategories, branches } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { updateExpenseSchema } from "@/lib/validation/expenses";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { recordExpenseLedgerEntry, reverseExpenseLedgerEntry } from "@/lib/ledger";
import { HttpError } from "@/lib/http-error";
import { requireBranchAccessForNullableTarget } from "@/lib/rbac/guard";

async function getOwnedExpense(restaurantId: string, expenseId: string) {
  const rows = await db
    .select()
    .from(expenses)
    .where(and(eq(expenses.id, expenseId), eq(expenses.restaurantId, restaurantId)))
    .limit(1);
  return rows[0] ?? null;
}

// No DELETE endpoint — an expense entry is corrected via PATCH (fixing a
// typo'd amount/category/date, only while NOT yet paid — see below) or
// voided via PATCH { isVoided: true } (soft delete), never hard-deleted —
// a wrong expense is still an audit trail of what was entered and when.
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ slug: string; expenseId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, expenseId } = await ctx.params;
    const { session, restaurantId, role, branchId: grantedBranchId, timezone } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_EXPENSES,
    );

    const existing = await getOwnedExpense(restaurantId, expenseId);
    if (!existing) {
      return NextResponse.json({ error: "Expense not found." }, { status: 404 });
    }
    // QA hardening pass — a branch-scoped manager must not be able to
    // edit/void a different branch's (or restaurant-wide) expense.
    await requireBranchAccessForNullableTarget(session.user.id, restaurantId, existing.branchId, {
      role,
      branchId: grantedBranchId,
    });

    const parsed = await parseJsonBody(request, updateExpenseSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;
    // Same "can only tag your own branch" restriction as create.
    if (grantedBranchId !== null && data.branchId !== undefined && data.branchId !== grantedBranchId) {
      return NextResponse.json(
        { error: "You can only reassign expenses to your own branch." },
        { status: 403 },
      );
    }

    // Once money has actually moved (status "paid"), the amount/category
    // are financial history, not a draft — never silently modify financial
    // history (spec section 30). Voiding (with its reversal entry, below)
    // is the correct way to fix a paid expense; description/note/date
    // typos are still fine to correct in place.
    const changingAmountOrCategory = data.amount !== undefined || data.categoryId !== undefined;
    if (existing.status === "paid" && changingAmountOrCategory) {
      throw new HttpError(
        "This expense has already been paid — void it and record a new one instead of changing the amount or category.",
      );
    }

    if (data.categoryId !== undefined) {
      const category = await db.query.expenseCategories.findFirst({
        where: and(eq(expenseCategories.id, data.categoryId), eq(expenseCategories.restaurantId, restaurantId)),
      });
      if (!category || !category.isActive) {
        return NextResponse.json({ error: "Choose a valid, active category." }, { status: 400 });
      }
    }
    if (data.branchId) {
      const branch = await db.query.branches.findFirst({
        where: and(eq(branches.id, data.branchId), eq(branches.restaurantId, restaurantId)),
      });
      if (!branch) {
        return NextResponse.json({ error: "That branch doesn't belong to this restaurant." }, { status: 400 });
      }
    }

    const togglingVoid = data.isVoided !== undefined && data.isVoided !== existing.isVoided;
    if (togglingVoid && existing.status !== "paid") {
      throw new HttpError("Only a paid expense can be voided — reject or edit a pending one instead.");
    }

    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(expenses)
        .set({
          ...(data.categoryId !== undefined ? { categoryId: data.categoryId } : {}),
          ...(data.amount !== undefined ? { amountInPaisa: data.amount } : {}),
          ...(data.description !== undefined ? { description: data.description } : {}),
          ...(data.expenseDate !== undefined ? { expenseDate: data.expenseDate } : {}),
          ...(data.note !== undefined ? { note: data.note || null } : {}),
          ...(data.branchId !== undefined ? { branchId: data.branchId } : {}),
          ...(data.isVoided !== undefined ? { isVoided: data.isVoided } : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(expenses.id, expenseId),
            eq(expenses.restaurantId, restaurantId),
            // QA hardening pass — CAS on isVoided when this request is
            // actually toggling it, matching the sibling approve/pay/reject
            // routes (and the payroll-payment void route) that already
            // guard their own status transitions this way. Without it, two
            // concurrent void requests both read isVoided=false, both pass
            // the check above, and both commit — reverseExpenseLedgerEntry
            // would run twice for one void, double-crediting the ledger.
            togglingVoid ? eq(expenses.isVoided, existing.isVoided) : undefined,
          ),
        )
        .returning();

      if (!row) return null;

      if (togglingVoid) {
        const category = await tx.query.expenseCategories.findFirst({
          where: eq(expenseCategories.id, row.categoryId),
        });
        const categoryLabel = category?.name ?? "Expense";
        if (data.isVoided) {
          await reverseExpenseLedgerEntry(tx, {
            restaurantId,
            expenseId: row.id,
            amountInPaisa: row.amountInPaisa,
            categoryLabel,
            description: row.description,
            timezone,
            recordedByUserId: session.user.id,
          });
        } else {
          await recordExpenseLedgerEntry(tx, {
            restaurantId,
            expenseId: row.id,
            amountInPaisa: row.amountInPaisa,
            categoryLabel,
            description: row.description,
            expenseDate: row.expenseDate,
            timezone,
            recordedByUserId: session.user.id,
          });
        }
      }

      return row;
    });

    if (!updated) {
      throw new HttpError(
        "This expense's void status was just changed by someone else. Please refresh and try again.",
        409,
      );
    }

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: togglingVoid ? (data.isVoided ? "expense.voided" : "expense.unvoided") : "expense.updated",
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
