/**
 * Phase 11c integration test: exercises the REAL callback route handler
 * (not a reimplementation) against a real database, using a locally-signed
 * eSewa callback payload — eSewa's signature scheme is pure HMAC-SHA256, no
 * network involved, so this is fully live-testable in this build sandbox
 * (unlike Khalti's initiate/lookup calls — see PHASE_11c_NOTES.md). Proves
 * the payment_gateway_transactions -> payments linkage: a verified callback
 * inserts a payments row, updates the order's cached paymentStatus, and
 * marks the transaction row completed + linked; a second identical
 * callback (the browser re-hitting the same URL) is idempotent and does
 * NOT insert a second payment.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { createHmac } from "node:crypto";

const hasDb = Boolean(process.env.DATABASE_URL);

// Matches getEsewaConfig()'s default test-env fallback (eSewa's own public
// UAT secret) — no env vars need to be set for this to work.
const ESEWA_TEST_SECRET = "8gBm/:&EnhH.1/q(";

function signEsewa(fields: { total_amount: string; transaction_uuid: string; product_code: string }) {
  const message = `total_amount=${fields.total_amount},transaction_uuid=${fields.transaction_uuid},product_code=${fields.product_code}`;
  return createHmac("sha256", ESEWA_TEST_SECRET).update(message).digest("base64");
}

function encodeEsewaData(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

describe.skipIf(!hasDb)("GET /api/payments/gateway/[gateway]/callback (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let GET: typeof import("./route").GET;

  let restaurantId: string;
  let branchId: string;
  let orderId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    GET = (await import("./route")).GET;

    const suffix = Math.random().toString(36).slice(2, 8);
    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-gwcb-${suffix}`, name: "TEST Gateway Callback Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "TEST Branch", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;

    const [order] = await db
      .insert(schema.orders)
      .values({
        restaurantId,
        branchId,
        orderNumber: `TEST-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
        source: "pos",
        status: "pending",
        subtotalInPaisa: 15000,
        taxInPaisa: 0,
        totalInPaisa: 15000,
      })
      .returning();
    orderId = order.id;
  });

  afterAll(async () => {
    await db
      .delete(schema.paymentGatewayTransactions)
      .where(eq(schema.paymentGatewayTransactions.restaurantId, restaurantId));
    await db.delete(schema.payments).where(eq(schema.payments.restaurantId, restaurantId));
    await db.delete(schema.orders).where(eq(schema.orders.restaurantId, restaurantId));
    await db.delete(schema.branches).where(eq(schema.branches.restaurantId, restaurantId));
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  async function callCallback(gateway: string, url: string) {
    return GET(new Request(url), {
      params: Promise.resolve({ gateway }),
    } as never);
  }

  it("verifies a signed eSewa callback, records a payment, and marks the transaction completed", async () => {
    const gatewayReference = crypto.randomUUID();
    await db.insert(schema.paymentGatewayTransactions).values({
      restaurantId,
      orderId,
      gateway: "esewa",
      status: "initiated",
      amountInPaisa: 15000,
      gatewayReference,
    });

    const fields = { total_amount: "150.00", transaction_uuid: gatewayReference, product_code: "EPAYTEST" };
    const dataParam = encodeEsewaData({
      transaction_code: "0000AB",
      status: "COMPLETE",
      ...fields,
      signed_field_names: "total_amount,transaction_uuid,product_code",
      signature: signEsewa(fields),
    });

    const url = `http://localhost:3100/api/payments/gateway/esewa/callback?outcome=success&ref=${gatewayReference}&data=${encodeURIComponent(dataParam)}`;
    const res = await callCallback("esewa", url);

    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("location")).toBe(`http://localhost:3100/dashboard/orders/${orderId}?payment=success`);

    const paymentRows = await db
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.orderId, orderId));
    expect(paymentRows).toHaveLength(1);
    expect(paymentRows[0].amountInPaisa).toBe(15000);
    expect(paymentRows[0].method).toBe("mobile_wallet");

    const [txn] = await db
      .select()
      .from(schema.paymentGatewayTransactions)
      .where(eq(schema.paymentGatewayTransactions.gatewayReference, gatewayReference));
    expect(txn.status).toBe("completed");
    expect(txn.paymentId).toBe(paymentRows[0].id);

    const [updatedOrder] = await db.select().from(schema.orders).where(eq(schema.orders.id, orderId));
    expect(updatedOrder.paymentStatus).toBe("paid");

    // Idempotent replay: the browser re-hits the exact same callback URL
    // (e.g. a refresh) — must redirect to success again WITHOUT inserting
    // a second payment.
    const res2 = await callCallback("esewa", url);
    expect(res2.headers.get("location")).toBe(`http://localhost:3100/dashboard/orders/${orderId}?payment=success`);

    const paymentRowsAfterReplay = await db
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.orderId, orderId));
    expect(paymentRowsAfterReplay).toHaveLength(1);
  });

  it("marks the transaction failed and redirects to ?payment=failed on a tampered signature", async () => {
    const gatewayReference = crypto.randomUUID();
    await db.insert(schema.paymentGatewayTransactions).values({
      restaurantId,
      orderId,
      gateway: "esewa",
      status: "initiated",
      amountInPaisa: 15000,
      gatewayReference,
    });

    const fields = { total_amount: "150.00", transaction_uuid: gatewayReference, product_code: "EPAYTEST" };
    const signature = signEsewa(fields);
    const dataParam = encodeEsewaData({
      transaction_code: "0000AB",
      status: "COMPLETE",
      total_amount: "999999.00", // tampered after signing
      transaction_uuid: fields.transaction_uuid,
      product_code: fields.product_code,
      signed_field_names: "total_amount,transaction_uuid,product_code",
      signature,
    });

    const url = `http://localhost:3100/api/payments/gateway/esewa/callback?outcome=success&ref=${gatewayReference}&data=${encodeURIComponent(dataParam)}`;
    const res = await callCallback("esewa", url);

    expect(res.headers.get("location")).toBe(`http://localhost:3100/dashboard/orders/${orderId}?payment=failed`);

    const [txn] = await db
      .select()
      .from(schema.paymentGatewayTransactions)
      .where(eq(schema.paymentGatewayTransactions.gatewayReference, gatewayReference));
    expect(txn.status).toBe("failed");
  });

  it("redirects to a generic failure page for an unknown gatewayReference", async () => {
    const url = `http://localhost:3100/api/payments/gateway/esewa/callback?outcome=success&ref=${crypto.randomUUID()}`;
    const res = await callCallback("esewa", url);
    expect(res.headers.get("location")).toBe("http://localhost:3100/dashboard/orders?payment=failed");
  });
});
