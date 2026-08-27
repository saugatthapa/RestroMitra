import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { suppliers } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { toCsv } from "@/lib/csv";

const EXPORT_ROW_LIMIT = 20_000;

/**
 * Commercial completion pass — Data Export gap. Gated on MANAGE_INVENTORY,
 * same as GET /suppliers itself (see that route's own comment on why
 * supplier data is treated as more sensitive than plain menu data).
 */
export async function GET(_request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_INVENTORY);

    const rows = await db
      .select()
      .from(suppliers)
      .where(eq(suppliers.restaurantId, restaurantId))
      .orderBy(asc(suppliers.name))
      .limit(EXPORT_ROW_LIMIT);

    const csv = toCsv(rows, [
      { header: "Name", value: (r) => r.name },
      { header: "Phone", value: (r) => r.phone ?? "" },
      { header: "Address", value: (r) => r.address ?? "" },
      { header: "Notes", value: (r) => r.notes ?? "" },
      { header: "Active", value: (r) => r.isActive },
    ]);

    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="suppliers.csv"`,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
