import { NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { restaurantTables, branches } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { createTableSchema } from "@/lib/validation/tables";
import { getMainBranch } from "@/lib/restaurant";
import { generateQrToken } from "@/lib/qr";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { requireBranchAccess } from "@/lib/rbac/guard";

/**
 * Phase 11a branch scoping: a staff member whose own grant is restricted
 * to one branch (userRoles.branchId non-null) only ever sees that branch's
 * tables, full stop — an explicit `?branchId=` from them is validated
 * against requireBranchAccess and simply can't widen past their grant.
 * An unrestricted caller (owner/manager, branchId null) sees every branch
 * by default, or can narrow to one via `?branchId=`.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await ctx.params;
    const { session, restaurantId, role, branchId: grantedBranchId } = await resolveRestaurantContext(slug);

    const url = new URL(request.url);
    const requestedBranchId = url.searchParams.get("branchId");
    const effectiveBranchId = grantedBranchId ?? requestedBranchId;
    if (effectiveBranchId) {
      await requireBranchAccess(session.user.id, restaurantId, effectiveBranchId, {
        role,
        branchId: grantedBranchId,
      });
    }

    const rows = await db
      .select()
      .from(restaurantTables)
      .where(
        effectiveBranchId
          ? and(eq(restaurantTables.restaurantId, restaurantId), eq(restaurantTables.branchId, effectiveBranchId))
          : eq(restaurantTables.restaurantId, restaurantId),
      )
      .orderBy(asc(restaurantTables.createdAt));

    return NextResponse.json({ tables: rows });
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
    const { session, restaurantId, role, branchId: grantedBranchId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_TABLES,
    );

    const parsed = await parseJsonBody(request, createTableSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    let branchId = data.branchId;
    if (branchId) {
      const owned = await db
        .select({ id: branches.id })
        .from(branches)
        .where(and(eq(branches.id, branchId), eq(branches.restaurantId, restaurantId)))
        .limit(1);
      if (owned.length === 0) {
        return NextResponse.json({ error: "Branch not found." }, { status: 404 });
      }
    } else if (grantedBranchId) {
      // A branch-scoped manager with no branchId in the request body means
      // "my own branch," not "the restaurant's main branch."
      branchId = grantedBranchId;
    } else {
      const main = await getMainBranch(restaurantId);
      if (!main) {
        return NextResponse.json(
          { error: "This restaurant has no branch set up yet." },
          { status: 400 },
        );
      }
      branchId = main.id;
    }

    await requireBranchAccess(session.user.id, restaurantId, branchId, {
      role,
      branchId: grantedBranchId,
    });

    // Token collisions are astronomically unlikely (32 random bytes) but a
    // unique index backs this regardless — retry once on the off chance.
    let table;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        [table] = await db
          .insert(restaurantTables)
          .values({
            restaurantId,
            branchId,
            name: data.name,
            capacity: data.capacity ?? null,
            floorLabel: data.floorLabel || null,
            qrToken: generateQrToken(),
          })
          .returning();
        break;
      } catch (err) {
        if (attempt === 2) throw err;
      }
    }

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "tables.created",
      resourceType: "table",
      resourceId: table!.id,
      ipAddress: getClientIp(request),
      metadata: { name: table!.name },
    });

    return NextResponse.json({ table }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
