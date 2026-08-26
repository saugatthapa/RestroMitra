import { NextResponse } from "next/server";
import { and, desc, eq, gte, isNull, lte, or } from "drizzle-orm";
import { db } from "@/db";
import { expenses, expenseCategories, branches } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { requireAnyPermission, hasPermission } from "@/lib/rbac/guard";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { createExpenseSchema } from "@/lib/validation/expenses";
import { EXPENSE_STATUSES, type ExpenseStatus } from "@/lib/finance/expense-status";
import { resolveInitialExpenseStatus } from "@/lib/finance/expense-workflow";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { recordExpenseLedgerEntry } from "@/lib/ledger";
import { HttpError } from "@/lib/http-error";
import { restaurantDate } from "@/lib/restaurant-date";

const EXPENSE_LIST_LIMIT = 500;

// Anyone who can touch expenses in ANY capacity (submit a request,
// create/edit outright, approve, or pay) can reach this route — the
// individual actions below are what's actually gated more tightly.
const ANY_EXPENSE_PERMISSION = [
  PERMISSIONS.MANAGE_EXPENSES,
  PERMISSIONS.CREATE_EXPENSE_REQUEST,
  PERMISSIONS.APPROVE_EXPENSE,
  PERMISSIONS.PAY_EXPENSE,
];

/**
 * `?categoryId=`, `?status=`, `?from=`, `?to=` (YYYY-MM-DD, inclusive)
 * narrow the list; voided entries are excluded unless `?includeVoided=true`
 * is passed, so the default view matches "what did we actually spend/owe."
 *
 * Visibility split (Phase 21): a caller who ONLY holds
 * CREATE_EXPENSE_REQUEST (e.g. a cashier submitting petty-cash requests)
 * sees just their OWN submitted expenses, not the restaurant's full
 * financial picture — that stays behind MANAGE_EXPENSES/APPROVE_EXPENSE/
 * PAY_EXPENSE, same "financial data isn't for every front-of-house role"
 * boundary the spec draws around payroll.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await ctx.params;
    const { session, restaurantId, role, branchId: grantedBranchId } = await resolveRestaurantContext(slug);
    await requireAnyPermission(session.user.id, restaurantId, ANY_EXPENSE_PERMISSION, role);

    const canSeeAll = await hasPermission(session.user.id, restaurantId, PERMISSIONS.MANAGE_EXPENSES, role) ||
      await hasPermission(session.user.id, restaurantId, PERMISSIONS.APPROVE_EXPENSE, role) ||
      await hasPermission(session.user.id, restaurantId, PERMISSIONS.PAY_EXPENSE, role);

    const url = new URL(request.url);
    const categoryId = url.searchParams.get("categoryId");
    const statusParam = url.searchParams.get("status");
    const status: ExpenseStatus | null =
      statusParam && (EXPENSE_STATUSES as readonly string[]).includes(statusParam)
        ? (statusParam as ExpenseStatus)
        : null;
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const includeVoided = url.searchParams.get("includeVoided") === "true";

    const rows = await db
      .select({
        expense: expenses,
        categoryName: expenseCategories.name,
        branchName: branches.name,
      })
      .from(expenses)
      .innerJoin(expenseCategories, eq(expenseCategories.id, expenses.categoryId))
      .leftJoin(branches, eq(branches.id, expenses.branchId))
      .where(
        and(
          eq(expenses.restaurantId, restaurantId),
          includeVoided ? undefined : eq(expenses.isVoided, false),
          categoryId ? eq(expenses.categoryId, categoryId) : undefined,
          status ? eq(expenses.status, status) : undefined,
          from ? gte(expenses.expenseDate, from) : undefined,
          to ? lte(expenses.expenseDate, to) : undefined,
          canSeeAll ? undefined : eq(expenses.recordedByUserId, session.user.id),
          // QA hardening pass — a branch-scoped caller only sees
          // restaurant-wide (branchId IS NULL) expenses plus their own
          // branch's, not every branch's spending.
          grantedBranchId === null
            ? undefined
            : or(isNull(expenses.branchId), eq(expenses.branchId, grantedBranchId)),
        ),
      )
      .orderBy(desc(expenses.expenseDate), desc(expenses.createdAt))
      .limit(EXPENSE_LIST_LIMIT);

    return NextResponse.json({
      expenses: rows.map((r) => ({
        ...r.expense,
        categoryName: r.categoryName,
        branchName: r.branchName,
      })),
    });
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
    const { session, restaurantId, role, branchId: grantedBranchId, timezone } = await resolveRestaurantContext(slug);
    await requireAnyPermission(session.user.id, restaurantId, ANY_EXPENSE_PERMISSION, role);

    const parsed = await parseJsonBody(request, createExpenseSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const category = await db.query.expenseCategories.findFirst({
      where: and(eq(expenseCategories.id, data.categoryId), eq(expenseCategories.restaurantId, restaurantId)),
    });
    if (!category || !category.isActive) {
      return NextResponse.json({ error: "Choose a valid, active category." }, { status: 400 });
    }

    // QA hardening pass — a branch-scoped submitter used to be able to tag
    // an expense to ANY branch of the restaurant (the client-supplied
    // branchId was only checked for existing, never for being THEIRS). A
    // branch-scoped caller may only tag their own branch — an explicit
    // mismatch is rejected; omitting it defaults to their own branch
    // rather than leaving it ambiguously restaurant-wide. An unrestricted
    // caller (owner/manager/platform_admin) keeps the original behavior:
    // any branch, or none (restaurant-wide).
    let branchId: string | null;
    if (grantedBranchId !== null) {
      if (data.branchId && data.branchId !== grantedBranchId) {
        return NextResponse.json(
          { error: "You can only record expenses for your own branch." },
          { status: 403 },
        );
      }
      branchId = grantedBranchId;
    } else {
      branchId = data.branchId ?? null;
    }
    if (branchId) {
      const branch = await db.query.branches.findFirst({
        where: and(eq(branches.id, branchId), eq(branches.restaurantId, restaurantId)),
      });
      if (!branch) {
        return NextResponse.json({ error: "That branch doesn't belong to this restaurant." }, { status: 400 });
      }
    }

    const [canApprove, canPay] = await Promise.all([
      hasPermission(session.user.id, restaurantId, PERMISSIONS.APPROVE_EXPENSE, role),
      hasPermission(session.user.id, restaurantId, PERMISSIONS.PAY_EXPENSE, role),
    ]);
    const status = resolveInitialExpenseStatus({ canApprove, canPay });

    if (status === "paid" && !data.paymentMethod) {
      throw new HttpError("A payment method is required to record this as paid.");
    }

    const expenseDate = data.expenseDate ?? restaurantDate(timezone);
    const now = new Date();

    // Committed together — an expense should never exist without its
    // matching Account Books entry once paid, or vice versa (same "one
    // write, two rows, one transaction" shape as order completion).
    const expense = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(expenses)
        .values({
          restaurantId,
          branchId,
          categoryId: data.categoryId,
          amountInPaisa: data.amount,
          description: data.description,
          expenseDate,
          note: data.note || null,
          status,
          paymentMethod: status === "paid" ? data.paymentMethod : null,
          approvedByUserId: status === "approved" || status === "paid" ? session.user.id : null,
          approvedAt: status === "approved" || status === "paid" ? now : null,
          paidByUserId: status === "paid" ? session.user.id : null,
          paidAt: status === "paid" ? now : null,
          recordedByUserId: session.user.id,
        })
        .returning();

      if (status === "paid") {
        await recordExpenseLedgerEntry(tx, {
          restaurantId,
          expenseId: row.id,
          amountInPaisa: row.amountInPaisa,
          categoryLabel: category.name,
          description: row.description,
          expenseDate,
          timezone,
          recordedByUserId: session.user.id,
        });
      }

      return row;
    });

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "expense.created",
      resourceType: "expense",
      resourceId: expense.id,
      ipAddress: getClientIp(request),
      metadata: { categoryId: expense.categoryId, amountInPaisa: expense.amountInPaisa, status },
    });

    return NextResponse.json({ expense: { ...expense, categoryName: category.name } }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
