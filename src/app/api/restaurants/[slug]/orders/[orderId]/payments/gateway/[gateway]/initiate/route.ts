import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { orders, payments, paymentGatewayTransactions } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { paymentGatewayParamSchema } from "@/lib/validation/payment-gateway";
import { computeBillingSummary } from "@/lib/payments";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { recordAuditLog } from "@/lib/audit";
import { buildEsewaFormFields } from "@/lib/payment-gateways/esewa";
import { initiateKhaltiPayment, KhaltiApiError } from "@/lib/payment-gateways/khalti";
import { requireBranchAccess } from "@/lib/rbac/guard";

/**
 * Starts a redirect-based gateway payment (eSewa form-POST or Khalti REST
 * initiate) for the order's current remaining due amount. Requires
 * EDIT_ORDER — same permission as recording a manual cash/card payment,
 * since this is just another way of settling a bill.
 *
 * A fresh `gatewayReference` (our own randomUUID, never anything from the
 * client) is generated and stored on a new `payment_gateway_transactions`
 * row before any gateway is contacted — this is the sole trust anchor the
 * public callback route uses to identify the order, mirroring the
 * `clientRequestId` idempotency pattern from Phase 11b.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string; orderId: string; gateway: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, orderId, gateway: rawGateway } = await ctx.params;
    const gatewayParsed = paymentGatewayParamSchema.safeParse(rawGateway);
    if (!gatewayParsed.success) {
      return NextResponse.json({ error: "Unknown payment gateway." }, { status: 400 });
    }
    const gateway = gatewayParsed.data;

    const { session, restaurantId, role, branchId: grantedBranchId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.EDIT_ORDER,
    );

    const order = await db.query.orders.findFirst({
      where: and(eq(orders.id, orderId), eq(orders.restaurantId, restaurantId)),
      with: { payments: true },
    });
    if (!order) {
      return NextResponse.json({ error: "Order not found." }, { status: 404 });
    }
    // QA hardening pass — same branch check the manual-payment route
    // already has; this gateway-initiate route was missing it.
    await requireBranchAccess(session.user.id, restaurantId, order.branchId, {
      role,
      branchId: grantedBranchId,
    });
    if (order.status === "cancelled") {
      return NextResponse.json(
        { error: "Cannot take a payment against a cancelled order." },
        { status: 400 },
      );
    }

    const billing = computeBillingSummary(
      order.totalInPaisa,
      order.payments.map((p: typeof payments.$inferSelect) => p.amountInPaisa),
    );
    if (billing.remainingDueInPaisa <= 0) {
      return NextResponse.json({ error: "This order is already fully paid." }, { status: 400 });
    }

    const appUrl = process.env.APP_URL ?? "http://localhost:3000";
    const gatewayReference = randomUUID();

    const [transaction] = await db
      .insert(paymentGatewayTransactions)
      .values({
        restaurantId,
        orderId,
        gateway,
        status: "initiated",
        amountInPaisa: billing.remainingDueInPaisa,
        gatewayReference,
        initiatedByUserId: session.user.id,
      })
      .returning();

    if (gateway === "esewa") {
      const successUrl = `${appUrl}/api/payments/gateway/esewa/callback?outcome=success&ref=${gatewayReference}`;
      const failureUrl = `${appUrl}/api/payments/gateway/esewa/callback?outcome=failure&ref=${gatewayReference}`;
      const { url, fields } = buildEsewaFormFields({
        amountInPaisa: billing.remainingDueInPaisa,
        transactionUuid: gatewayReference,
        successUrl,
        failureUrl,
      });

      await recordAuditLog({
        restaurantId,
        userId: session.user.id,
        action: "payment.gateway_initiated",
        resourceType: "payment_gateway_transaction",
        resourceId: transaction.id,
        ipAddress: getClientIp(request),
        metadata: { orderId, gateway, amountInPaisa: billing.remainingDueInPaisa },
      });

      return NextResponse.json({ gateway, formUrl: url, fields });
    }

    // gateway === "khalti"
    const returnUrl = `${appUrl}/api/payments/gateway/khalti/callback?ref=${gatewayReference}`;
    try {
      const result = await initiateKhaltiPayment({
        amountInPaisa: billing.remainingDueInPaisa,
        purchaseOrderId: gatewayReference,
        purchaseOrderName: `Order ${order.orderNumber}`,
        returnUrl,
        websiteUrl: appUrl,
      });

      await db
        .update(paymentGatewayTransactions)
        .set({ rawResponse: { pidx: result.pidx }, updatedAt: new Date() })
        .where(eq(paymentGatewayTransactions.id, transaction.id));

      await recordAuditLog({
        restaurantId,
        userId: session.user.id,
        action: "payment.gateway_initiated",
        resourceType: "payment_gateway_transaction",
        resourceId: transaction.id,
        ipAddress: getClientIp(request),
        metadata: { orderId, gateway, amountInPaisa: billing.remainingDueInPaisa },
      });

      return NextResponse.json({ gateway, paymentUrl: result.payment_url });
    } catch (err) {
      await db
        .update(paymentGatewayTransactions)
        .set({
          status: "failed",
          rawResponse: err instanceof KhaltiApiError ? { error: err.body } : { error: String(err) },
          updatedAt: new Date(),
        })
        .where(eq(paymentGatewayTransactions.id, transaction.id));
      return NextResponse.json(
        { error: "Could not start the Khalti payment. Please try again." },
        { status: 502 },
      );
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}
