import { NextResponse } from "next/server";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { payrollPayments, userRoles, users } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { createPayrollPaymentSchema } from "@/lib/validation/payroll";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { recordPayrollLedgerEntry } from "@/lib/ledger";
import { restaurantDate } from "@/lib/restaurant-date";
import { getPayrollComputation } from "@/lib/payroll";
import { requireBranchAccessForNullableTarget } from "@/lib/rbac/guard";
import { isUniqueViolation } from "@/lib/db-error";
import { assertBusinessDayWritable } from "@/lib/daily-closing";

const PAYROLL_LIST_LIMIT = 500;

/**
 * `?userRoleId=` narrows to one staff member's payout history.
 *
 * QA hardening pass — a branch-scoped accountant/manager only sees payout
 * history for staff scoped to their own branch (or unrestricted staff),
 * joining to userRoles since payrollPayments itself has no branchId column.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId, branchId: grantedBranchId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.VIEW_PAYROLL,
    );

    const url = new URL(request.url);
    const userRoleId = url.searchParams.get("userRoleId");

    const rows = await db
      .select({ payment: payrollPayments })
      .from(payrollPayments)
      .innerJoin(userRoles, eq(payrollPayments.userRoleId, userRoles.id))
      .where(
        and(
          eq(payrollPayments.restaurantId, restaurantId),
          userRoleId ? eq(payrollPayments.userRoleId, userRoleId) : undefined,
          grantedBranchId === null
            ? undefined
            : or(isNull(userRoles.branchId), eq(userRoles.branchId, grantedBranchId)),
        ),
      )
      .orderBy(desc(payrollPayments.paidAt))
      .limit(PAYROLL_LIST_LIMIT);

    return NextResponse.json({ payments: rows.map((r) => r.payment) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Pays a staff member directly — no approve step (MANAGE_PAYROLL is a
 * single permission; whoever holds it just records the payout). "Cash"
 * means "manually enter the amount" exactly like every other method here —
 * there's no payout API for ANY method to pull a number from, so the
 * amount is always typed in by the person confirming the payment (see
 * payout-methods.ts's doc comment).
 *
 * Gap audit (P1) — `requireOwnerMfa: true` additionally requires MFA to be
 * enabled when the CALLER is the owner (a no-op for an accountant/manager
 * running the same payroll payment — see requireOwnerMfaEnabled's own doc
 * comment in guard.ts).
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug } = await ctx.params;
    const { session, restaurantId, role, branchId: grantedBranchId, timezone } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_PAYROLL,
      { requireOwnerMfa: true },
    );

    const parsed = await parseJsonBody(request, createPayrollPaymentSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const staffRow = await db
      .select({ userRoleId: userRoles.id, fullName: users.fullName, branchId: userRoles.branchId })
      .from(userRoles)
      .innerJoin(users, eq(userRoles.userId, users.id))
      .where(and(eq(userRoles.id, data.userRoleId), eq(userRoles.restaurantId, restaurantId)))
      .limit(1);
    if (staffRow.length === 0) {
      return NextResponse.json({ error: "Staff member not found." }, { status: 404 });
    }
    const staff = staffRow[0];
    // QA hardening pass — a branch-scoped manager holding MANAGE_PAYROLL
    // must not be able to pay a different branch's (or a restaurant-wide)
    // staff member.
    await requireBranchAccessForNullableTarget(session.user.id, restaurantId, staff.branchId, {
      role,
      branchId: grantedBranchId,
    });

    const paymentDate = restaurantDate(timezone);

    // Commercial Launch Phase B.2 — when a period is given, recompute the
    // owed amount server-side (never trust a client-supplied computed
    // figure — it could be stale or tampered) and snapshot it alongside
    // whatever amount is actually being paid, even if a human typed in
    // something different. See the computedAmountInPaisa column comment
    // in schema.ts.
    const computation =
      data.periodStart && data.periodEnd
        ? await getPayrollComputation(restaurantId, data.userRoleId, data.periodStart, data.periodEnd, timezone)
        : null;

    // QA hardening pass — idempotent create, same shape as the expenses
    // route's own clientRequestId handling (see that route's doc
    // comment): a pre-check up front, plus a catch-and-recover on the
    // partial unique index's 23505 for two concurrent identical retries.
    if (data.clientRequestId) {
      const existingRows = await db
        .select()
        .from(payrollPayments)
        .where(
          and(
            eq(payrollPayments.restaurantId, restaurantId),
            eq(payrollPayments.clientRequestId, data.clientRequestId),
          ),
        )
        .limit(1);
      if (existingRows[0]) {
        return NextResponse.json({ payment: existingRows[0], idempotentReplay: true }, { status: 200 });
      }
    }

    // Committed together, same "one write, two rows, one transaction"
    // shape as expense payment — a payroll payment should never exist
    // without its matching (name-redacted) Account Books debit.
    let payment;
    try {
      payment = await db.transaction(async (tx) => {
        // QA hardening pass (Phase 5 / centralized daily-close lock) — a
        // payroll payment is a real cash-out with its own Account Books
        // debit (recordPayrollLedgerEntry below), keyed to `paymentDate`
        // (today). Skipped for a restaurant-wide staff member (branchId
        // null) — same documented per-branch limitation as expenses: Daily
        // Closing has no single branch to check for staff not scoped to
        // one.
        if (staff.branchId) {
          await assertBusinessDayWritable(
            {
              userId: session.user.id,
              restaurantId,
              branchId: staff.branchId,
              businessDate: paymentDate,
              role,
            },
            tx,
          );
        }

        const [row] = await tx
          .insert(payrollPayments)
          .values({
            restaurantId,
            userRoleId: data.userRoleId,
            staffNameSnapshot: staff.fullName,
            amountInPaisa: data.amount,
            payPeriodLabel: data.payPeriodLabel || null,
            periodStart: data.periodStart ?? null,
            periodEnd: data.periodEnd ?? null,
            paymentMethod: data.paymentMethod,
            note: data.note || null,
            paidByUserId: session.user.id,
            computedAmountInPaisa: computation?.owedAmountInPaisa ?? null,
            attendanceMinutesSnapshot: computation?.attendanceMinutes ?? null,
            attendanceDaysSnapshot: computation?.attendanceDays ?? null,
            deductionsJson: data.deductions?.length
              ? data.deductions.map((d) => ({ label: d.label, amountInPaisa: d.amount }))
              : null,
            clientRequestId: data.clientRequestId || null,
          })
          .returning();

        await recordPayrollLedgerEntry(tx, {
          restaurantId,
          payrollPaymentId: row.id,
          amountInPaisa: row.amountInPaisa,
          payPeriodLabel: row.payPeriodLabel,
          paymentDate,
          timezone,
          recordedByUserId: session.user.id,
        });

        return row;
      });
    } catch (err) {
      // A concurrent duplicate submission of the SAME retry raced us past
      // the pre-check above and lost the unique-index collision — recover
      // by returning what the winner actually committed.
      if (data.clientRequestId && isUniqueViolation(err)) {
        const raceRows = await db
          .select()
          .from(payrollPayments)
          .where(
            and(
              eq(payrollPayments.restaurantId, restaurantId),
              eq(payrollPayments.clientRequestId, data.clientRequestId),
            ),
          )
          .limit(1);
        if (raceRows[0]) {
          return NextResponse.json({ payment: raceRows[0], idempotentReplay: true }, { status: 200 });
        }
      }
      throw err;
    }

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "payroll.paid",
      resourceType: "payroll_payment",
      resourceId: payment.id,
      ipAddress: getClientIp(request),
      metadata: {
        staffUserRoleId: data.userRoleId,
        amountInPaisa: payment.amountInPaisa,
        paymentMethod: payment.paymentMethod,
      },
    });

    return NextResponse.json({ payment }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
