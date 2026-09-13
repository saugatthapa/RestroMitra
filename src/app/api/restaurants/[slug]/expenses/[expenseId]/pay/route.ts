import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { expenses, expenseCategories, branches } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { payExpenseSchema } from "@/lib/validation/expenses";
import { canTransitionExpenseStatus } from "@/lib/finance/expense-status";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { recordExpenseLedgerEntry } from "@/lib/ledger";
import { HttpError } from "@/lib/http-error";
import { assertBusinessDayWritable } from "@/lib/daily-closing";
import { assertRegisterOpenForCashPayment } from "@/lib/cash-register";
import { isAutomaticPostingEnabled } from "@/lib/accounting/automatic-posting";
import { postExpenseVoucher, type AutoProvisionedAccount } from "@/lib/accounting/integrations/expenses";

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
    const { session, restaurantId, role, timezone } = await resolveRestaurantContext(
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

    const txResult = await db.transaction(async (tx) => {
      // QA hardening pass (Phase 5 / centralized daily-close lock) — THIS
      // is the moment an expense actually becomes a real cash-out (see the
      // create route's own comment on why pending_approval/approved has no
      // ledger effect yet) — so this is where the lock genuinely needs to
      // apply, keyed off the expense's own expenseDate (the business day
      // it counts toward in Daily Closing/Reports), not "now". Skipped for
      // a restaurant-wide expense (branchId null) — same documented
      // per-branch limitation as the create route.
      if (existing.branchId) {
        await assertBusinessDayWritable(
          {
            userId: session.user.id,
            restaurantId,
            branchId: existing.branchId,
            businessDate: existing.expenseDate,
            role,
          },
          tx,
        );

        // Same guard as the orders payments/refunds routes (Phase 6 /
        // master prompt section 9) — paying an expense in cash is a cash-out
        // of the till exactly like a cash refund, so it needs the same
        // "some register is actually open at this branch" precondition
        // before this money is treated as having left a real, tracked
        // drawer. See assertRegisterOpenForCashPayment's own doc comment in
        // cash-register.ts. Scoped to `existing.branchId` being set for the
        // same documented reason the daily-close lock above is: a
        // restaurant-wide expense (no specific branch) has no till to check.
        if (parsed.data.paymentMethod === "cash") {
          await assertRegisterOpenForCashPayment(tx, { restaurantId, branchId: existing.branchId });
        }
      }

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

      // Accounting module Phase 4, Slice 4d — see the create route's own
      // comment on the restaurant-wide-expense branch fallback (identical
      // reasoning here).
      let autoProvisioned: AutoProvisionedAccount | null = null;
      if (await isAutomaticPostingEnabled(tx, restaurantId)) {
        const voucherBranchId =
          row.branchId ??
          (
            await tx
              .select({ id: branches.id })
              .from(branches)
              .where(and(eq(branches.restaurantId, restaurantId), eq(branches.isMain, true)))
              .limit(1)
          )[0]?.id;
        if (voucherBranchId) {
          const posted = await postExpenseVoucher(tx, {
            restaurantId,
            branchId: voucherBranchId,
            expenseId: row.id,
            categoryId: row.categoryId,
            categoryName: category?.name ?? "Expense",
            amountInPaisa: row.amountInPaisa,
            paymentMethod: parsed.data.paymentMethod,
            timezone,
            createdByUserId: session.user.id,
          });
          autoProvisioned = posted.autoProvisionedAccount;
        }
      }

      return { row, autoProvisioned };
    });

    if (!txResult) {
      throw new HttpError("This expense was just updated by someone else. Please refresh.", 409);
    }
    const updated = txResult.row;
    const autoProvisionedAccount = txResult.autoProvisioned;

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "expense.paid",
      resourceType: "expense",
      resourceId: expenseId,
      ipAddress: getClientIp(request),
      metadata: { paymentMethod: parsed.data.paymentMethod, amountInPaisa: updated.amountInPaisa },
    });

    if (autoProvisionedAccount) {
      await recordAuditLog({
        restaurantId,
        userId: session.user.id,
        action: "accounting.account_auto_created",
        resourceType: "chart_of_accounts",
        resourceId: autoProvisionedAccount.id,
        ipAddress: getClientIp(request),
        metadata: { code: autoProvisionedAccount.code, name: autoProvisionedAccount.name, reason: "expense_category_first_use" },
      });
    }

    return NextResponse.json({ expense: updated });
  } catch (err) {
    return toErrorResponse(err);
  }
}
