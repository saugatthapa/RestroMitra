import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { branches } from "@/db/schema";
import { requirePlatformPermission } from "@/lib/rbac/guard";
import { PLATFORM_PERMISSIONS } from "@/lib/rbac/platform-permissions";
import { toErrorResponse } from "@/lib/api-route-helpers";

/**
 * Gap-audit P1 fix (Finding 2) — the restaurant detail page's branch list.
 * A single restaurantId-scoped query (branches_restaurant_id_idx already
 * covers it), same VIEW_TENANTS gate as the detail route itself — branch
 * info isn't support-team-sensitive the way internal notes/health score
 * are, so this doesn't need the narrower MANAGE_SUPPORT gate.
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ restaurantId: string }> },
) {
  try {
    await requirePlatformPermission(PLATFORM_PERMISSIONS.VIEW_TENANTS);
    const { restaurantId } = await ctx.params;

    const rows = await db
      .select({
        id: branches.id,
        name: branches.name,
        address: branches.address,
        city: branches.city,
        phone: branches.phone,
        isMain: branches.isMain,
        isActive: branches.isActive,
        createdAt: branches.createdAt,
      })
      .from(branches)
      .where(eq(branches.restaurantId, restaurantId))
      .orderBy(desc(branches.isMain), branches.name);

    return NextResponse.json({ branches: rows });
  } catch (err) {
    return toErrorResponse(err);
  }
}
