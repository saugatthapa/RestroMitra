import { NextResponse } from "next/server";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { db } from "@/db";
import { expenses } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { createExpenseSchema } from "@/lib/validation/expenses";
import { EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABELS, type ExpenseCategory } from "@/lib/expense-categories";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { recordExpenseLedgerEntry } from "@/lib/ledger";

const EXPENSE_LIST_LIMIT = 500;

/**
 * Expenses are gated behind MANAGE_EXPENSES (manager/owner by default —
 * see DEFAULT_ROLE_PERMISSIONS) for both reads and writes, same trust
 * level as MANAGE_STAFF/MANAGE_INVENTORY: operational spending is
 * profit-adjacent data, not something every front-of-house role sees.
 *
 * `?category=`, `?from=`, `?to=` (YYYY-MM-DD, inclusive) narrow the list;
 * voided entries are excluded unless `?includeVoided=true` is passed, so
 * the default view matches "what did we actually spend."
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_EXPENSES);

    const url = new URL(request.url);
    const categoryParam = url.searchParams.get("category");
    const category: ExpenseCategory | null =
      categoryParam && (EXPENSE_CATEGORIES as readonly string[]).includes(categoryParam)
        ? (categoryParam as ExpenseCategory)
        : null;
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const includeVoided = url.searchParams.get("includeVoided") === "true";

    const rows = await db
      .select()
      .from(expenses)
      .where(
        and(
          eq(expenses.restaurantId, restaurantId),
          includeVoided ? undefined : eq(expenses.isVoided, false),
          category ? eq(expenses.category, category) : undefined,
          from ? gte(expenses.expenseDate, from) : undefined,
          to ? lte(expenses.expenseDate, to) : undefined,
        ),
      )
      .orderBy(desc(expenses.expenseDate), desc(expenses.createdAt))
      .limit(EXPENSE_LIST_LIMIT);

    return NextResponse.json({ expenses: rows });
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

    const parsed = await parseJsonBody(request, createExpenseSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const expenseDate = data.expenseDate ?? new Date().toISOString().slice(0, 10);

    // Committed together — an expense should never exist without its
    // matching Account Books entry, or vice versa, same "one write, two
    // rows, one transaction" shape as order completion's loyalty +
    // ledger writes (see recordSalesLedgerEntry's own comment).
    const expense = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(expenses)
        .values({
          restaurantId,
          category: data.category,
          amountInPaisa: data.amount,
          description: data.description,
          expenseDate,
          note: data.note || null,
          recordedByUserId: session.user.id,
        })
        .returning();

      await recordExpenseLedgerEntry(tx, {
        restaurantId,
        expenseId: row.id,
        amountInPaisa: row.amountInPaisa,
        categoryLabel: EXPENSE_CATEGORY_LABELS[row.category as ExpenseCategory],
        description: row.description,
        expenseDate,
        recordedByUserId: session.user.id,
      });

      return row;
    });

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "expense.created",
      resourceType: "expense",
      resourceId: expense.id,
      ipAddress: getClientIp(request),
      metadata: { category: expense.category, amountInPaisa: expense.amountInPaisa },
    });

    return NextResponse.json({ expense }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
