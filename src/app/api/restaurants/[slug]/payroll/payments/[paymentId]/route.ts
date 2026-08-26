import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { payrollPayments, userRoles } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { reversePayrollLedgerEntry } from "@/lib/ledger";
import { HttpError } from "@/lib/http-error";
import { requireBranchAccessForNullableTarget } from "@/lib/rbac/guard";
import { restaurantDate } from "@/lib/restaurant-date";
import { assertBusinessDayWritable } from "@/lib/daily-closing";

/**
 * Voids a payroll payment — recorded to the wrong person, wrong amount,
 * duplicate entry. Same "reverse via a new ledger credit, never mutate or
 * delete the original" pattern as expenses. Only ever un-does a genuine
 * mistake; it does NOT claw back real money — that's a conversation with
 * the staff member, not something this button does.
 */
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ slug: string; paymentId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, paymentId } = await ctx.params;
    const { session, restaurantId, role, branchId: grantedBranchId, timezone } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_PAYROLL,
    );

    const existing = await db.query.payrollPayments.findFirst({
      where: and(eq(payrollPayments.id, paymentId), eq(payrollPayments.restaurantId, restaurantId)),
    });
    if (!existing) {
      return NextResponse.json({ error: "Payroll payment not found." }, { status: 404 });
    }
    // QA hardening pass — a branch-scoped manager must not be able to void
    // a different branch's (or a restaurant-wide) staff member's payment.
    const [targetStaff] = await db
      .select({ branchId: userRoles.branchId })
      .from(userRoles)
      .where(eq(userRoles.id, existing.userRoleId))
      .limit(1);
    await requireBranchAccessForNullableTarget(
      session.user.id,
      restaurantId,
      targetStaff?.branchId ?? null,
      { role, branchId: grantedBranchId },
    );
    if (existing.isVoided) {
      throw new HttpError("This payment is already voided.");
    }

    const updated = await db.transaction(async (tx) => {
      // QA hardening pass (Phase 43 / adversarial self-audit — daily-close
      // lock coverage gap). Voiding reverses this payment's ledger entry —
      // a genuine financial reversal, same class as every other mutation
      // this hardening pass gated behind the daily-close lock, but this
      // one was missed since it edits an existing payment rather than
      // creating one. Keyed off the payment's own paidAt business date
      // (the day its ledger entry was originally booked on), gated on the
      // staff member actually having a branch — same "restaurant-wide
      // staff have no branch-scoped daily close to protect" rule the
      // create/pay route itself already uses.
      if (targetStaff?.branchId) {
        await assertBusinessDayWritable(
          {
            userId: session.user.id,
            restaurantId,
            branchId: targetStaff.branchId,
            businessDate: restaurantDate(timezone, existing.paidAt),
            role,
          },
          tx,
        );
      }

      const [row] = await tx
        .update(payrollPayments)
        .set({ isVoided: true, updatedAt: new Date() })
        .where(
          and(
            eq(payrollPayments.id, paymentId),
            eq(payrollPayments.restaurantId, restaurantId),
            eq(payrollPayments.isVoided, false),
          ),
        )
        .returning();

      if (!row) return null;

      await reversePayrollLedgerEntry(tx, {
        restaurantId,
        payrollPaymentId: row.id,
        amountInPaisa: row.amountInPaisa,
        payPeriodLabel: row.payPeriodLabel,
        timezone,
        recordedByUserId: session.user.id,
      });

      return row;
    });

    if (!updated) {
      throw new HttpError("This payment was just updated by someone else. Please refresh.", 409);
    }

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "payroll.voided",
      resourceType: "payroll_payment",
      resourceId: paymentId,
      ipAddress: getClientIp(request),
      metadata: { amountInPaisa: updated.amountInPaisa, staffUserRoleId: updated.userRoleId },
    });

    return NextResponse.json({ payment: updated });
  } catch (err) {
    return toErrorResponse(err);
  }
}
