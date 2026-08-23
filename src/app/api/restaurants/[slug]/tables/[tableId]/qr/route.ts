import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { restaurantTables } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { requireBranchAccess } from "@/lib/rbac/guard";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { buildOrderUrl, generateQrToken, renderQrPng } from "@/lib/qr";

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ slug: string; tableId: string }> },
) {
  try {
    const { slug, tableId } = await ctx.params;
    // Viewing/printing a QR code is a read of already-scoped data, not a
    // structural change — any staff member with restaurant access (not
    // just MANAGE_TABLES holders) can fetch it, mirroring the read/write
    // split used elsewhere (e.g. menu GET vs POST).
    const { restaurantId } = await resolveRestaurantContext(slug);

    const rows = await db
      .select()
      .from(restaurantTables)
      .where(and(eq(restaurantTables.id, tableId), eq(restaurantTables.restaurantId, restaurantId)))
      .limit(1);
    const table = rows[0];
    if (!table) {
      return NextResponse.json({ error: "Table not found." }, { status: 404 });
    }

    const appUrl = process.env.APP_URL ?? "http://localhost:3000";
    const orderUrl = buildOrderUrl(appUrl, table.qrToken);
    const png = await renderQrPng(orderUrl);

    return new NextResponse(new Uint8Array(png), {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "private, max-age=60",
        "Content-Disposition": `inline; filename="table-${table.name.replace(/[^a-z0-9]+/gi, "-")}-qr.png"`,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * RC audit P1 fix — regenerates a table's QR token, invalidating the old
 * one. Previously a table's qrToken could never be rotated once created —
 * the token IS the entire access control for the public, unauthenticated
 * `/order/[token]` ordering page (see that route's own doc comment), so a
 * leaked or photographed code (a customer's screenshot shared publicly, a
 * stolen/damaged table tent left in the wrong hands) could only be
 * neutralized by deleting and recreating the table outright — losing its
 * name/capacity/branch history and any reservations/orders still pointing
 * at it.
 *
 * Gated MANAGE_TABLES (same as every other table-mutating action) plus a
 * branch-access re-check, same pattern as this table's own PATCH route.
 * The old token stops resolving immediately: `/order/[oldToken]` now looks
 * up a row that no longer exists (see the order route's own qrToken
 * lookup), so any QR code, printed poster, or bookmark using it goes dead
 * the moment this returns — staff still need to reprint/redisplay the new
 * one (this route only rotates the token + returns the new PNG; it can't
 * reach out and update a table tent physically at the restaurant).
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

    const rows = await db
      .select()
      .from(restaurantTables)
      .where(and(eq(restaurantTables.id, tableId), eq(restaurantTables.restaurantId, restaurantId)))
      .limit(1);
    const existing = rows[0];
    if (!existing) {
      return NextResponse.json({ error: "Table not found." }, { status: 404 });
    }
    await requireBranchAccess(session.user.id, restaurantId, existing.branchId, {
      role,
      branchId: grantedBranchId,
    });

    // 32 bytes of randomness (see generateQrToken's own doc comment) — a
    // collision against any existing token is not a real-world concern,
    // same risk tolerance this codebase already applies to clientRequestId
    // UUIDs (see payments-idempotency.test.ts's own comment), so no
    // retry-on-unique-violation loop here.
    const qrToken = generateQrToken();
    const [updated] = await db
      .update(restaurantTables)
      .set({ qrToken, updatedAt: new Date() })
      .where(and(eq(restaurantTables.id, tableId), eq(restaurantTables.restaurantId, restaurantId)))
      .returning();

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "tables.qr_regenerated",
      resourceType: "table",
      resourceId: tableId,
      ipAddress: getClientIp(request),
    });

    const appUrl = process.env.APP_URL ?? "http://localhost:3000";
    return NextResponse.json({
      table: updated,
      orderUrl: buildOrderUrl(appUrl, updated.qrToken),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
