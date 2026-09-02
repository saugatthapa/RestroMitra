import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { customers } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { adjustLoyaltySchema } from "@/lib/validation/customers";
import { recordLoyaltyTransaction } from "@/lib/loyalty";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Manual loyalty point adjustment — a manager/cashier crediting or
 * debiting a customer's balance by hand (goodwill points, a redeemed
 * reward, a correction). Always goes through recordLoyaltyTransaction so
 * it lands in the same ledger as automatic order-completion earnings;
 * there is no separate "just edit the balance" path anywhere in this app.
 *
 * "redeem" is recorded as type "redeem" (negative delta); "add" is
 * recorded as type "adjustment" (positive delta, NOT "earn") — it
 * deliberately does not bump lifetimePointsEarned/tier standing, since a
 * manual goodwill credit isn't the same signal as money the customer
 * actually spent (see loyalty-tiers.ts).
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string; customerId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, customerId } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_CUSTOMERS,
    );

    const existing = await db
      .select({ id: customers.id, loyaltyPointsBalance: customers.loyaltyPointsBalance })
      .from(customers)
      .where(and(eq(customers.id, customerId), eq(customers.restaurantId, restaurantId)))
      .limit(1);
    const customer = existing[0];
    if (!customer) {
      return NextResponse.json({ error: "Customer not found." }, { status: 404 });
    }

    const parsed = await parseJsonBody(request, adjustLoyaltySchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    if (data.direction === "redeem" && data.points > customer.loyaltyPointsBalance) {
      return NextResponse.json(
        { error: "This customer doesn't have enough points for that redemption." },
        { status: 400 },
      );
    }

    const result = await db.transaction(async (tx) => {
      return recordLoyaltyTransaction(tx, {
        restaurantId,
        customerId,
        type: data.direction === "redeem" ? "redeem" : "adjustment",
        pointsDelta: data.direction === "redeem" ? -data.points : data.points,
        referenceType: "manual",
        note: data.reason,
        recordedByUserId: session.user.id,
      });
    });
    // recordLoyaltyTransaction only returns null on a reference-collision
    // no-op (see its doc comment), which requires a referenceId — this
    // call never passes one, so it always inserts. Narrowed here only to
    // satisfy the now-nullable return type.
    if (!result) {
      return NextResponse.json({ error: "Could not record this adjustment." }, { status: 500 });
    }

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "customer.loyalty_adjusted",
      resourceType: "customer",
      resourceId: customerId,
      ipAddress: getClientIp(request),
      metadata: { direction: data.direction, points: data.points, reason: data.reason },
    });

    return NextResponse.json({ customer: result.customer, transaction: result.transaction });
  } catch (err) {
    return toErrorResponse(err);
  }
}
