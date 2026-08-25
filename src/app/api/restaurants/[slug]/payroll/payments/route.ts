import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
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

const PAYROLL_LIST_LIMIT = 500;

/** `?userRoleId=` narrows to one staff member's payout history. */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.VIEW_PAYROLL);

    const url = new URL(request.url);
    const userRoleId = url.searchParams.get("userRoleId");

    const rows = await db
      .select({ payment: payrollPayments })
      .from(payrollPayments)
      .where(
        and(
          eq(payrollPayments.restaurantId, restaurantId),
          userRoleId ? eq(payrollPayments.userRoleId, userRoleId) : undefined,
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
    const { session, restaurantId, timezone } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_PAYROLL,
    );

    const parsed = await parseJsonBody(request, createPayrollPaymentSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const staffRow = await db
      .select({ userRoleId: userRoles.id, fullName: users.fullName })
      .from(userRoles)
      .innerJoin(users, eq(userRoles.userId, users.id))
      .where(and(eq(userRoles.id, data.userRoleId), eq(userRoles.restaurantId, restaurantId)))
      .limit(1);
    if (staffRow.length === 0) {
      return NextResponse.json({ error: "Staff member not found." }, { status: 404 });
    }
    const staff = staffRow[0];

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

    // Committed together, same "one write, two rows, one transaction"
    // shape as expense payment — a payroll payment should never exist
    // without its matching (name-redacted) Account Books debit.
    const payment = await db.transaction(async (tx) => {
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
