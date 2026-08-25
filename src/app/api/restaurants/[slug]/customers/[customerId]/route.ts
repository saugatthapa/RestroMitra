import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { customers } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { updateCustomerSchema } from "@/lib/validation/customers";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { reconcileBirthdayBonus } from "@/lib/loyalty";
import { getCustomerOutstandingBalance, listLedgerEntries } from "@/lib/ledger";

const RECENT_ORDERS_LIMIT = 25;
const RECENT_LEDGER_LIMIT = 50;
// Commercial Launch Phase B.5 — Customer Credit. Recent credit/tab history
// shown on the CRM profile — same "one call rather than three round trips"
// reasoning as the loyalty ledger below, not a paginated ledger view (that
// already exists at Account Books' own MANAGE_ACCOUNT_BOOKS-gated screen).
const RECENT_CREDIT_LIMIT = 50;

/**
 * Customer detail view: the CRM record itself, plus a recent-order history
 * and loyalty ledger so the dashboard detail page (and, later, a POS
 * customer lookup) can show "who is this person" in one call rather than
 * three round trips.
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ slug: string; customerId: string }> },
) {
  try {
    const { slug, customerId } = await ctx.params;
    const { restaurantId, timezone } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_CUSTOMERS);

    let customer = await db.query.customers.findFirst({
      where: (c, { and: dAnd, eq: dEq }) =>
        dAnd(dEq(c.id, customerId), dEq(c.restaurantId, restaurantId)),
    });
    if (!customer) {
      return NextResponse.json({ error: "Customer not found." }, { status: 404 });
    }

    // The other "self-healing on read" birthday checkpoint (see
    // reconcileBirthdayBonus) — a staff member pulling up this exact
    // customer's CRM profile on their birthday should trigger the bonus
    // even if the list view above wasn't the entry point (e.g. reached
    // directly from a reservation or an order's linked customer).
    const awarded = await db.transaction((tx) => reconcileBirthdayBonus(tx, customer!, timezone));
    if (awarded) {
      const refreshed = await db.query.customers.findFirst({
        where: (c, { and: dAnd, eq: dEq }) =>
          dAnd(dEq(c.id, customerId), dEq(c.restaurantId, restaurantId)),
      });
      if (refreshed) customer = refreshed;
    }

    const [recentOrders, loyaltyLedger, outstandingCreditInPaisa, creditLedger] = await Promise.all([
      db.query.orders.findMany({
        where: (o, { and: dAnd, eq: dEq }) =>
          dAnd(dEq(o.customerId, customerId), dEq(o.restaurantId, restaurantId)),
        orderBy: (o, { desc }) => [desc(o.placedAt)],
        limit: RECENT_ORDERS_LIMIT,
        columns: {
          id: true,
          orderNumber: true,
          status: true,
          totalInPaisa: true,
          placedAt: true,
        },
      }),
      db.query.loyaltyTransactions.findMany({
        where: (t, { and: dAnd, eq: dEq }) =>
          dAnd(dEq(t.customerId, customerId), dEq(t.restaurantId, restaurantId)),
        orderBy: (t, { desc }) => [desc(t.createdAt)],
        limit: RECENT_LEDGER_LIMIT,
      }),
      // Commercial Launch Phase B.5 — Customer Credit.
      getCustomerOutstandingBalance(restaurantId, customerId),
      listLedgerEntries(restaurantId, { customerId }, RECENT_CREDIT_LIMIT),
    ]);

    return NextResponse.json({
      customer,
      recentOrders,
      loyaltyLedger,
      outstandingCreditInPaisa,
      creditLedger,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Edits customer profile fields and/or toggles isActive (soft-delete —
 * this app never hard-deletes customer records, same as every other
 * entity). Loyalty balances are NOT editable here; that's the dedicated
 * loyalty/adjust route, which goes through the ledger.
 */
export async function PATCH(
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
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.id, customerId), eq(customers.restaurantId, restaurantId)))
      .limit(1);
    if (existing.length === 0) {
      return NextResponse.json({ error: "Customer not found." }, { status: 404 });
    }

    const parsed = await parseJsonBody(request, updateCustomerSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const [updated] = await db
      .update(customers)
      .set({
        ...(data.fullName !== undefined ? { fullName: data.fullName } : {}),
        ...(data.email !== undefined ? { email: data.email || null } : {}),
        ...(data.dateOfBirth !== undefined ? { dateOfBirth: data.dateOfBirth || null } : {}),
        ...(data.notes !== undefined ? { notes: data.notes || null } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        ...(data.creditLimit !== undefined ? { creditLimitInPaisa: data.creditLimit } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(customers.id, customerId), eq(customers.restaurantId, restaurantId)))
      .returning();

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "customer.updated",
      resourceType: "customer",
      resourceId: customerId,
      ipAddress: getClientIp(request),
      metadata: { changes: data },
    });

    return NextResponse.json({ customer: updated });
  } catch (err) {
    return toErrorResponse(err);
  }
}
