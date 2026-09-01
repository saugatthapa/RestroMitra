import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { orders, payments, paymentGatewayTransactions } from "@/db/schema";
import { paymentGatewayParamSchema } from "@/lib/validation/payment-gateway";
import { computeBillingSummary } from "@/lib/payments";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp } from "@/lib/request";
import { rateLimit } from "@/lib/rate-limit";
import { verifyEsewaCallback } from "@/lib/payment-gateways/esewa";
import { lookupKhaltiPayment, KHALTI_COMPLETED_STATUS } from "@/lib/payment-gateways/khalti";
import { markGatewayTransactionFailed } from "@/lib/payment-gateways/transaction-status";

/**
 * Public, UNAUTHENTICATED endpoint — the browser lands here after eSewa or
 * Khalti redirects it back from their hosted payment page. There is no
 * session and no restaurant slug in the URL; the entire trust boundary is
 * `gatewayReference` (our own randomUUID, generated and stored server-side
 * at initiate time — see the initiate route) plus, for each gateway, a
 * cryptographic/server-to-server check that the payment actually completed:
 * eSewa signs its callback payload with a secret only we and eSewa know;
 * Khalti requires a server-to-server lookup keyed on the pidx WE stored,
 * never the query string's own pidx. Query-string amounts/statuses/order
 * ids are never trusted directly for either gateway.
 *
 * Always finishes by redirecting the browser to the order's dashboard page
 * — this route has no HTML of its own, it's a pure server-side landing pad.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ gateway: string }> },
) {
  const appUrl = process.env.APP_URL ?? "http://localhost:3000";
  const { gateway: rawGateway } = await ctx.params;
  const gatewayParsed = paymentGatewayParamSchema.safeParse(rawGateway);
  const searchParams = new URL(request.url).searchParams;

  if (!gatewayParsed.success) {
    return NextResponse.redirect(`${appUrl}/dashboard/orders?payment=failed`);
  }
  const gateway = gatewayParsed.data;

  const failRedirect = (orderId?: string) =>
    NextResponse.redirect(
      orderId ? `${appUrl}/dashboard/orders/${orderId}?payment=failed` : `${appUrl}/dashboard/orders?payment=failed`,
    );

  // --- Resolve our own transaction row -----------------------------------
  let gatewayReference: string | null = null;
  if (gateway === "esewa") {
    gatewayReference = searchParams.get("ref");
  } else {
    gatewayReference = searchParams.get("ref") ?? searchParams.get("purchase_order_id");
  }
  if (!gatewayReference) return failRedirect();

  // This route is public/unauthenticated by design (see the doc comment
  // above), and unlike the other public routes in this app it wasn't rate
  // limited at all — someone holding a valid `gatewayReference` (their own
  // in-flight payment) could hammer this URL, forcing a repeated Khalti
  // server-to-server lookup call and a repeated DB transaction per hit.
  // Not a money-forgery risk (verification stays cryptographic), but cheap
  // resource/outbound-API abuse worth closing off. Limited both per-IP
  // (generic abuse) and per-reference (this exact in-flight payment).
  const ip = getClientIp(request);
  const ipLimit = await rateLimit(`gateway-callback:ip:${ip}`, { limit: 30, windowMs: 10 * 60 * 1000 });
  const refLimit = await rateLimit(`gateway-callback:ref:${gatewayReference}`, {
    limit: 10,
    windowMs: 10 * 60 * 1000,
  });
  if (!ipLimit.allowed || !refLimit.allowed) {
    return new NextResponse("Too many requests. Please wait a few minutes and try again.", {
      status: 429,
    });
  }

  const transaction = await db.query.paymentGatewayTransactions.findFirst({
    where: eq(paymentGatewayTransactions.gatewayReference, gatewayReference),
  });
  if (!transaction) return failRedirect();

  // Already resolved (e.g. the browser re-hit this URL on refresh) —
  // idempotent no-op, redirect straight through without reprocessing.
  if (transaction.status === "completed") {
    return NextResponse.redirect(`${appUrl}/dashboard/orders/${transaction.orderId}?payment=success`);
  }
  if (transaction.status === "failed" || transaction.status === "cancelled") {
    return failRedirect(transaction.orderId);
  }

  // --- Gateway-specific verification --------------------------------------
  let verified = false;
  let gatewayTransactionId: string | null = null;
  let rawResponse: unknown = null;

  if (gateway === "esewa") {
    const dataParam = searchParams.get("data");
    const outcome = searchParams.get("outcome");
    if (outcome === "success" && dataParam) {
      const payload = verifyEsewaCallback(dataParam);
      if (
        payload &&
        payload.transaction_uuid === gatewayReference &&
        payload.status === "COMPLETE" &&
        Number(payload.total_amount) === transaction.amountInPaisa / 100
      ) {
        verified = true;
        gatewayTransactionId = payload.transaction_code;
        rawResponse = payload;
      } else {
        rawResponse = payload;
      }
    }
  } else {
    const rawResult = transaction.rawResponse as { pidx?: string } | null;
    const pidx = rawResult?.pidx;
    if (pidx) {
      try {
        const lookup = await lookupKhaltiPayment(pidx);
        rawResponse = lookup;
        if (
          lookup.status === KHALTI_COMPLETED_STATUS &&
          lookup.total_amount === transaction.amountInPaisa
        ) {
          verified = true;
          gatewayTransactionId = lookup.transaction_id;
        }
      } catch (err) {
        rawResponse = { error: String(err) };
      }
    }
  }

  if (!verified) {
    // RC audit P0 fix — this used to be an unconditional UPDATE with no
    // status guard, unlike the success path below (which locks + re-checks
    // before writing). That let a stale/duplicate delivery whose OWN
    // verification independently failed (e.g. a transient Khalti lookup
    // error) silently overwrite a genuine "completed" status written by a
    // concurrent, correctly-verified request — even though the money and
    // the `payments` row from that real success were untouched, the field
    // THIS route's own idempotency fast-path reads (line ~83 above) would
    // then be wrong, so a follow-up page refresh would tell staff/guest
    // the payment failed when it had actually succeeded and was recorded.
    // The guarded lock-then-conditionally-update logic lives in
    // markGatewayTransactionFailed so it's directly regression-tested
    // against a real database rather than only provable by reading this
    // route.
    const { finalStatus } = await markGatewayTransactionFailed(transaction.id, rawResponse);
    if (finalStatus === "completed") {
      return NextResponse.redirect(`${appUrl}/dashboard/orders/${transaction.orderId}?payment=success`);
    }
    return failRedirect(transaction.orderId);
  }

  // --- Success: record the payment, exactly like a manual payment --------
  //
  // The transaction row is re-fetched here under a `FOR UPDATE` lock and
  // its status is re-checked BEFORE inserting anything (QA hardening pass)
  // — without this, two overlapping hits on this exact callback URL (a
  // double-click, a browser retry, the gateway itself re-delivering the
  // redirect) can both pass the early `transaction.status === "completed"`
  // fast-path check above (both read "initiated" before either commits),
  // both pass verification, and both insert a `payments` row for the same
  // real-world gateway transaction — double-crediting the order. The lock
  // makes the second request wait for the first to commit, then see
  // status "completed" and short-circuit to the already-recorded payment
  // instead of inserting a second one.
  const result = await db.transaction(async (tx) => {
    const [lockedTxn] = await tx
      .select()
      .from(paymentGatewayTransactions)
      .where(eq(paymentGatewayTransactions.id, transaction.id))
      .for("update")
      .limit(1);
    if (!lockedTxn) return null;

    if (lockedTxn.status === "completed") {
      const existingPayment = lockedTxn.paymentId
        ? (
            await tx.select().from(payments).where(eq(payments.id, lockedTxn.paymentId)).limit(1)
          )[0]
        : undefined;
      return existingPayment ? { payment: existingPayment, alreadyCompleted: true as const } : null;
    }

    const orderRows = await tx.select().from(orders).where(eq(orders.id, transaction.orderId)).limit(1);
    const order = orderRows[0];
    if (!order) return null;

    const existingPayments = await tx
      .select({ amountInPaisa: payments.amountInPaisa })
      .from(payments)
      .where(eq(payments.orderId, order.id));

    // The gateway already collected this money in the real world by the
    // time this callback runs — unlike the manual-payment route, we can't
    // "reject" it just because the order looks fully paid already (e.g. a
    // cashier recorded a cash payment while this gateway session was still
    // pending). Recording it and flagging the overlap for staff to review
    // is the safe choice; silently discarding real, already-collected
    // money would be worse.
    const before = computeBillingSummary(
      order.totalInPaisa,
      existingPayments.map((p) => p.amountInPaisa),
    );
    const possibleOverpayment = before.remainingDueInPaisa <= 0;

    const [payment] = await tx
      .insert(payments)
      .values({
        restaurantId: transaction.restaurantId,
        orderId: order.id,
        amountInPaisa: transaction.amountInPaisa,
        method: "mobile_wallet",
        note: possibleOverpayment
          ? `Paid via ${gateway === "esewa" ? "eSewa" : "Khalti"} (order already showed fully paid — please review for a possible refund)`
          : `Paid via ${gateway === "esewa" ? "eSewa" : "Khalti"}`,
        recordedByUserId: transaction.initiatedByUserId,
      })
      .returning();

    const after = computeBillingSummary(order.totalInPaisa, [
      ...existingPayments.map((p) => p.amountInPaisa),
      payment.amountInPaisa,
    ]);

    await tx
      .update(orders)
      .set({ paymentStatus: after.paymentStatus, updatedAt: new Date() })
      .where(eq(orders.id, order.id));

    await tx
      .update(paymentGatewayTransactions)
      .set({
        status: "completed",
        gatewayTransactionId,
        rawResponse: rawResponse ?? undefined,
        paymentId: payment.id,
        updatedAt: new Date(),
      })
      .where(eq(paymentGatewayTransactions.id, transaction.id));

    return { payment, order, possibleOverpayment };
  });

  if (!result) return failRedirect(transaction.orderId);
  if ("alreadyCompleted" in result) {
    return NextResponse.redirect(`${appUrl}/dashboard/orders/${transaction.orderId}?payment=success`);
  }

  await recordAuditLog({
    restaurantId: transaction.restaurantId,
    userId: transaction.initiatedByUserId,
    action: "payment.gateway_completed",
    resourceType: "payment",
    resourceId: result.payment.id,
    ipAddress: getClientIp(request),
    metadata: {
      orderId: transaction.orderId,
      gateway,
      amountInPaisa: transaction.amountInPaisa,
      gatewayTransactionId,
      possibleOverpayment: result.possibleOverpayment,
    },
  });

  return NextResponse.redirect(`${appUrl}/dashboard/orders/${transaction.orderId}?payment=success`);
}
