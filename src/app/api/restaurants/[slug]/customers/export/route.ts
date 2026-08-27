import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { customers } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { getCustomerOutstandingBalancesByRestaurant } from "@/lib/ledger";
import { paisaToRupees } from "@/lib/money";
import { toCsv } from "@/lib/csv";

const EXPORT_ROW_LIMIT = 20_000;

/**
 * Commercial completion pass — Data Export gap. Gated on MANAGE_CUSTOMERS,
 * same as GET /customers itself. Outstanding credit balance comes from
 * getCustomerOutstandingBalancesByRestaurant (ledger.ts) — one grouped
 * aggregate query rather than N+1 per row.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_CUSTOMERS);

    const rows = await db
      .select()
      .from(customers)
      .where(eq(customers.restaurantId, restaurantId))
      .orderBy(desc(customers.createdAt))
      .limit(EXPORT_ROW_LIMIT);

    const balanceByCustomerId = await getCustomerOutstandingBalancesByRestaurant(restaurantId);

    const csv = toCsv(rows, [
      { header: "Name", value: (r) => r.fullName },
      { header: "Phone", value: (r) => r.phone },
      { header: "Email", value: (r) => r.email ?? "" },
      { header: "Loyalty points", value: (r) => r.loyaltyPointsBalance },
      { header: "Total orders", value: (r) => r.totalOrdersCount },
      { header: "Total spent (Rs)", value: (r) => paisaToRupees(r.totalSpentInPaisa) },
      {
        header: "Credit limit (Rs)",
        value: (r) => (r.creditLimitInPaisa === null ? "" : paisaToRupees(r.creditLimitInPaisa)),
      },
      {
        header: "Outstanding balance (Rs)",
        value: (r) => paisaToRupees(balanceByCustomerId.get(r.id) ?? 0),
      },
      { header: "Active", value: (r) => r.isActive },
    ]);

    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="customers.csv"`,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
