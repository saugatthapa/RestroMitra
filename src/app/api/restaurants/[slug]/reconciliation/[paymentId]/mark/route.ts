import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { orders, payments } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { markPaymentReconciled } from "@/lib/financial-reconciliation";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

// Phase 5, Slice 5b — `bankAccountId` is a new, optional field: a
// restaurant with more than one active bank account must pass it (see
// resolveBankAccountForPosting's own doc comment); every other restaurant
// can keep sending no body at all, exactly as before this slice —
// `request.json()` on an empty body rejects to `null`, which this schema
// accepts and normalizes to `{}`.
const markReconciledBodySchema = z
  .object({ bankAccountId: z.string().uuid().optional() })
  .nullable()
  .transform((v) => v ?? {});

/**
 * A human has checked their bank/gateway statement and confirmed this
 * payment settled — mark it reconciled. The payment id comes from the URL;
 * an optional JSON body carries `bankAccountId` when one needs to be
 * chosen (see the schema comment above).
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string; paymentId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, paymentId } = await ctx.params;
    const parsedBody = await parseJsonBody(request, markReconciledBodySchema);
    if (!parsedBody.ok) return parsedBody.response;
    const {
      session,
      restaurantId,
      role,
      branchId: grantedBranchId,
      timezone,
    } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_ACCOUNT_BOOKS);

    // payments has no branchId of its own — resolve via its order, same
    // rationale as the reconciliation list/summary queries.
    const [existing] = await db
      .select({ id: payments.id, branchId: orders.branchId })
      .from(payments)
      .innerJoin(orders, eq(payments.orderId, orders.id))
      .where(and(eq(payments.id, paymentId), eq(payments.restaurantId, restaurantId)))
      .limit(1);
    if (!existing) {
      return NextResponse.json({ error: "Payment not found." }, { status: 404 });
    }
    await requireBranchAccess(session.user.id, restaurantId, existing.branchId, {
      role,
      branchId: grantedBranchId,
    });

    const updated = await db.transaction((tx) =>
      markPaymentReconciled(tx, {
        restaurantId,
        paymentId,
        reconciledByUserId: session.user.id,
        timezone,
        bankAccountId: parsedBody.data.bankAccountId,
      }),
    );

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "payments.reconciled",
      resourceType: "payment",
      resourceId: paymentId,
      ipAddress: getClientIp(request),
    });

    return NextResponse.json({ payment: updated });
  } catch (err) {
    return toErrorResponse(err);
  }
}
