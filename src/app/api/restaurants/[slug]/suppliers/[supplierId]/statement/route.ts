import { NextResponse } from "next/server";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { getSupplierStatement } from "@/lib/supplier-statement";
import { supplierStatementRangeSchema } from "@/lib/validation/supplier-statement";

/**
 * Supplier Statement (Gap Audit P1) — a running ledger for one supplier:
 * opening balance + purchases − payments ± adjustments = closing balance,
 * for an optional [from, to] date range. See getSupplierStatement's own
 * doc comment (supplier-statement.ts) for the full accounting shape and
 * the reconciliation guarantee against getSupplierDueReport's point-in-time
 * figure.
 *
 * Tenant isolation: getSupplierStatement itself verifies `supplierId`
 * belongs to `restaurantId` (throwing a 404 otherwise) before reading any
 * ledger rows — the same "resolve-then-verify" shape every other
 * supplier-scoped route in this file tree uses (see suppliers/[supplierId]/
 * route.ts's getOwnedSupplier).
 *
 * Gated on MANAGE_INVENTORY, matching the existing due-report route's own
 * gate — this is the same "supply-chain data" trust tier, just history
 * instead of a snapshot.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ slug: string; supplierId: string }> },
) {
  try {
    const { slug, supplierId } = await ctx.params;
    const { restaurantId, timezone } = await resolveRestaurantContext(slug, PERMISSIONS.MANAGE_INVENTORY);

    const url = new URL(request.url);
    const parsed = supplierStatementRangeSchema.safeParse({
      from: url.searchParams.get("from") || undefined,
      to: url.searchParams.get("to") || undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid date range." },
        { status: 400 },
      );
    }

    if (parsed.data.from && parsed.data.to && parsed.data.from > parsed.data.to) {
      return NextResponse.json({ error: "`from` must not be after `to`." }, { status: 400 });
    }

    const statement = await getSupplierStatement(restaurantId, supplierId, timezone, parsed.data);
    return NextResponse.json(statement);
  } catch (err) {
    return toErrorResponse(err);
  }
}
