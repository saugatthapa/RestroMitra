import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { restaurantTables } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { mergeTableSchema } from "@/lib/validation/orders";
import { mergeTables } from "@/lib/tables";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Commercial Launch Phase B.7 — Table Operations. Batch-transfers every
 * active order from `fromTableId` (request body) onto `:tableId` (the URL
 * param — the destination, matching this route living under
 * /tables/[tableId]/merge, i.e. "merge INTO this table") — see
 * mergeTables's own comment in src/lib/tables.ts. Gated MANAGE_TABLES, same
 * tier as transfer.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string; tableId: string }> },
) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug, tableId } = await ctx.params;
    const { session, restaurantId, role, branchId: grantedBranchId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_TABLES,
    );

    const parsed = await parseJsonBody(request, mergeTableSchema);
    if (!parsed.ok) return parsed.response;

    // Branch-check against the DESTINATION table (the source's branch is
    // implicitly covered — mergeTables/transferOrderToTable reject moving
    // an order across branches regardless).
    const toTableRows = await db
      .select({ branchId: restaurantTables.branchId })
      .from(restaurantTables)
      .where(and(eq(restaurantTables.id, tableId), eq(restaurantTables.restaurantId, restaurantId)))
      .limit(1);
    if (!toTableRows[0]) {
      return NextResponse.json({ error: "Table not found." }, { status: 404 });
    }
    await requireBranchAccess(session.user.id, restaurantId, toTableRows[0].branchId, {
      role,
      branchId: grantedBranchId,
    });

    const result = await db.transaction((tx) =>
      mergeTables(tx, { restaurantId, fromTableId: parsed.data.fromTableId, toTableId: tableId }),
    );

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "table.merged",
      resourceType: "table",
      resourceId: tableId,
      ipAddress: getClientIp(request),
      metadata: { fromTableId: parsed.data.fromTableId, toTableId: tableId, movedOrderIds: result.movedOrderIds },
    });

    return NextResponse.json({ movedOrderIds: result.movedOrderIds });
  } catch (err) {
    return toErrorResponse(err);
  }
}
