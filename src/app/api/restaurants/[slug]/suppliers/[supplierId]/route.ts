import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { suppliers } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { updateSupplierSchema } from "@/lib/validation/inventory";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

async function getOwnedSupplier(restaurantId: string, supplierId: string) {
  const rows = await db
    .select()
    .from(suppliers)
    .where(and(eq(suppliers.id, supplierId), eq(suppliers.restaurantId, restaurantId)))
    .limit(1);
  return rows[0] ?? null;
}

// No DELETE endpoint — suppliers are deactivated via PATCH { isActive: false }
// (soft delete, same pattern as menu items), since a supplier may already be
// referenced by historical purchases and inventory items' preferredSupplierId.
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ slug: string; supplierId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, supplierId } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_INVENTORY,
    );

    const existing = await getOwnedSupplier(restaurantId, supplierId);
    if (!existing) {
      return NextResponse.json({ error: "Supplier not found." }, { status: 404 });
    }

    const parsed = await parseJsonBody(request, updateSupplierSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: "No changes provided." }, { status: 400 });
    }

    const [updated] = await db
      .update(suppliers)
      .set({
        ...data,
        phone: data.phone === undefined ? undefined : data.phone || null,
        address: data.address === undefined ? undefined : data.address || null,
        notes: data.notes === undefined ? undefined : data.notes || null,
        updatedAt: new Date(),
      })
      .where(and(eq(suppliers.id, supplierId), eq(suppliers.restaurantId, restaurantId)))
      .returning();

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "inventory.supplier.updated",
      resourceType: "supplier",
      resourceId: supplierId,
      ipAddress: getClientIp(request),
      metadata: { fields: Object.keys(data) },
    });

    return NextResponse.json({ supplier: updated });
  } catch (err) {
    return toErrorResponse(err);
  }
}
