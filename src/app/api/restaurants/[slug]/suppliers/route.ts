import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { suppliers } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { createSupplierSchema } from "@/lib/validation/inventory";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Suppliers are gated behind MANAGE_INVENTORY for both reads and writes —
 * unlike the menu subsystem's GET-open/write-gated split, ingredient/supply
 * chain data (who we buy from, at what cost) is treated as more sensitive
 * than menu availability and isn't exposed to waiters/cashiers/kitchen
 * staff by default.
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_INVENTORY);

    const rows = await db
      .select()
      .from(suppliers)
      .where(eq(suppliers.restaurantId, restaurantId))
      .orderBy(asc(suppliers.name));

    return NextResponse.json({ suppliers: rows });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_INVENTORY,
    );

    const parsed = await parseJsonBody(request, createSupplierSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const [supplier] = await db
      .insert(suppliers)
      .values({
        restaurantId,
        name: data.name,
        phone: data.phone || null,
        address: data.address || null,
        notes: data.notes || null,
      })
      .returning();

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "inventory.supplier.created",
      resourceType: "supplier",
      resourceId: supplier.id,
      ipAddress: getClientIp(request),
      metadata: { name: supplier.name },
    });

    return NextResponse.json({ supplier }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
