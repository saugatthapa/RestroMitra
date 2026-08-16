import { NextResponse } from "next/server";
import { and, eq, ilike, or } from "drizzle-orm";
import { db } from "@/db";
import { customers } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { createCustomerSchema } from "@/lib/validation/customers";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { reconcileBirthdayBonus } from "@/lib/loyalty";
import { isBirthdayToday, BIRTHDAY_BONUS_POINTS } from "@/lib/loyalty-birthday";

const CUSTOMER_LIST_LIMIT = 200;

/**
 * Lists (optionally search-filtered) customers for the restaurant's CRM,
 * gated on MANAGE_CUSTOMERS (manager/cashier by default — see
 * DEFAULT_ROLE_PERMISSIONS). `q` matches phone or full name, case
 * insensitive — the two things a cashier is actually looking up a
 * customer by at the till. This is also the endpoint POS's customer
 * search hits, so it's one of the two "self-healing on read" birthday
 * checkpoints (see reconcileBirthdayBonus) — a cashier searching up a
 * birthday customer to attach them to an order is exactly the moment the
 * bonus should land, independent of whether that search turns into a
 * completed order.
 */
export async function GET(
  request: Request,
  ctx: RouteContext<"/api/restaurants/[slug]/customers">,
) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_CUSTOMERS);

    const url = new URL(request.url);
    const q = url.searchParams.get("q")?.trim();

    const rows = await db.query.customers.findMany({
      where: (c, { and: dAnd, eq: dEq }) =>
        dAnd(
          dEq(c.restaurantId, restaurantId),
          q ? or(ilike(c.phone, `%${q}%`), ilike(c.fullName, `%${q}%`)) : undefined,
        ),
      orderBy: (c, { desc }) => [desc(c.createdAt)],
      limit: CUSTOMER_LIST_LIMIT,
    });

    // Cheap in almost every call: isBirthdayToday is a plain string
    // compare, so this loop only ever does DB work for rows that actually
    // match today's month+day (birthdays are rare on any given page load).
    const todayIso = new Date().toISOString().slice(0, 10);
    const currentYear = Number(todayIso.slice(0, 4));
    const dueForBonus = rows.filter(
      (c) => isBirthdayToday(c.dateOfBirth, todayIso) && c.lastBirthdayBonusYear !== currentYear,
    );
    for (const customer of dueForBonus) {
      const awarded = await db.transaction((tx) => reconcileBirthdayBonus(tx, customer));
      if (awarded) {
        customer.lastBirthdayBonusYear = currentYear;
        customer.loyaltyPointsBalance += BIRTHDAY_BONUS_POINTS;
        customer.lifetimePointsEarned += BIRTHDAY_BONUS_POINTS;
      }
    }

    return NextResponse.json({ customers: rows });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Creates a new CRM customer record. Phone is unique per restaurant (see
 * customers_restaurant_phone_unique) — the same phone number can exist as
 * separate customer records at different restaurants, but not twice at
 * the same one.
 */
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/restaurants/[slug]/customers">,
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_CUSTOMERS,
    );

    const parsed = await parseJsonBody(request, createCustomerSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const existing = await db
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.restaurantId, restaurantId), eq(customers.phone, data.phone)))
      .limit(1);
    if (existing.length > 0) {
      return NextResponse.json(
        { error: "A customer with this phone number already exists." },
        { status: 409 },
      );
    }

    const [created] = await db
      .insert(customers)
      .values({
        restaurantId,
        phone: data.phone,
        fullName: data.fullName,
        email: data.email || null,
        dateOfBirth: data.dateOfBirth || null,
        notes: data.notes || null,
      })
      .returning();

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "customer.created",
      resourceType: "customer",
      resourceId: created.id,
      ipAddress: getClientIp(request),
      metadata: { phone: created.phone },
    });

    return NextResponse.json({ customer: created }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
