import { NextResponse } from "next/server";
import { asc, count, eq } from "drizzle-orm";
import { db } from "@/db";
import { categories } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { createCategorySchema } from "@/lib/validation/menu";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug);

    const rows = await db
      .select()
      .from(categories)
      .where(eq(categories.restaurantId, restaurantId))
      .orderBy(asc(categories.sortOrder), asc(categories.createdAt));

    return NextResponse.json({ categories: rows });
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
      PERMISSIONS.EDIT_MENU,
    );

    const parsed = await parseJsonBody(request, createCategorySchema);
    if (!parsed.ok) return parsed.response;

    // New categories go to the end of the list.
    const [{ total }] = await db
      .select({ total: count() })
      .from(categories)
      .where(eq(categories.restaurantId, restaurantId));
    const nextSort = total;

    const [category] = await db
      .insert(categories)
      .values({ restaurantId, name: parsed.data.name, sortOrder: nextSort })
      .returning();

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "menu.category.created",
      resourceType: "category",
      resourceId: category.id,
      ipAddress: getClientIp(request),
      metadata: { name: category.name },
    });

    return NextResponse.json({ category }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
