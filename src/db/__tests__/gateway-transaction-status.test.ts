/**
 * RC audit integration test: proves `markGatewayTransactionFailed`'s
 * lock-then-conditionally-update guard actually holds against a real
 * database — the exact production code path the payment-gateway callback
 * route (src/app/api/payments/gateway/[gateway]/callback/route.ts) calls
 * when its own verification of the gateway's response comes back negative.
 *
 * The bug this guards against: the callback route can be hit more than
 * once for the same in-flight payment (double-click, browser retry, the
 * gateway itself re-delivering the redirect). One hit can succeed (a real,
 * correctly-verified completion) while another, concurrent or later, hit
 * fails its OWN verification. Without the guard, the failing hit's update
 * would silently overwrite the successful hit's "completed" status back to
 * "failed" — the money and `payments` row from the real success stay
 * untouched, but the field the route's idempotency fast-path reads would
 * now be wrong.
 *
 * Skipped (not failed) when DATABASE_URL isn't set, same as the other
 * DB-backed integration tests in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("markGatewayTransactionFailed (integration)", () => {
  let db: typeof import("@/db").db;
  let schema: typeof import("@/db/schema");
  let markGatewayTransactionFailed: typeof import("@/lib/payment-gateways/transaction-status").markGatewayTransactionFailed;

  let restaurantId: string;
  let branchId: string;
  let orderId: string;

  beforeAll(async () => {
    db = (await import("@/db")).db;
    schema = await import("@/db/schema");
    ({ markGatewayTransactionFailed } = await import("@/lib/payment-gateways/transaction-status"));

    const suffix = Math.random().toString(36).slice(2, 8);
    const [restaurant] = await db
      .insert(schema.restaurants)
      .values({ slug: `test-gw-status-${suffix}`, name: "TEST Gateway-Status Restaurant" })
      .returning({ id: schema.restaurants.id });
    restaurantId = restaurant.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ restaurantId, name: "TEST Main", isMain: true })
      .returning({ id: schema.branches.id });
    branchId = branch.id;

    const [order] = await db
      .insert(schema.orders)
      .values({
        restaurantId,
        branchId,
        orderNumber: `TEST-GW-${suffix}`,
        source: "qr_customer",
        status: "pending",
        subtotalInPaisa: 100_00,
        taxInPaisa: 0,
        totalInPaisa: 100_00,
      })
      .returning({ id: schema.orders.id });
    orderId = order.id;
  });

  afterAll(async () => {
    await db.delete(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
  });

  function gatewayTxnRow(status: "initiated" | "completed" | "failed") {
    return {
      restaurantId,
      orderId,
      gateway: "esewa" as const,
      gatewayReference: crypto.randomUUID(),
      amountInPaisa: 100_00,
      status,
    };
  }

  it("marks an 'initiated' transaction failed", async () => {
    const [txn] = await db
      .insert(schema.paymentGatewayTransactions)
      .values(gatewayTxnRow("initiated"))
      .returning({ id: schema.paymentGatewayTransactions.id });

    const result = await markGatewayTransactionFailed(txn.id, { reason: "verification failed" });
    expect(result).toEqual({ downgraded: true, finalStatus: "failed" });

    const [reloaded] = await db
      .select({ status: schema.paymentGatewayTransactions.status })
      .from(schema.paymentGatewayTransactions)
      .where(eq(schema.paymentGatewayTransactions.id, txn.id));
    expect(reloaded.status).toBe("failed");
  });

  it("does NOT downgrade a transaction already 'completed'", async () => {
    const [txn] = await db
      .insert(schema.paymentGatewayTransactions)
      .values(gatewayTxnRow("completed"))
      .returning({ id: schema.paymentGatewayTransactions.id });

    const result = await markGatewayTransactionFailed(txn.id, { reason: "a losing, stale verification" });
    expect(result).toEqual({ downgraded: false, finalStatus: "completed" });

    const [reloaded] = await db
      .select({ status: schema.paymentGatewayTransactions.status })
      .from(schema.paymentGatewayTransactions)
      .where(eq(schema.paymentGatewayTransactions.id, txn.id));
    expect(reloaded.status).toBe("completed");
  });

  it("returns a null finalStatus for a transaction id that doesn't exist", async () => {
    const result = await markGatewayTransactionFailed(crypto.randomUUID(), null);
    expect(result).toEqual({ downgraded: false, finalStatus: null });
  });
});
