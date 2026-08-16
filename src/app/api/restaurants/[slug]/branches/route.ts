import { NextResponse } from "next/server";
import { and, asc, count, eq } from "drizzle-orm";
import { db } from "@/db";
import { branches, restaurants } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { createBranchSchema } from "@/lib/validation/branches";
import { maxBranchesForRestaurant } from "@/lib/plans";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";

/**
 * Lists every branch for the restaurant — open to any active staff member
 * (same "reads are open, writes are gated" split as tables/menu GETs).
 * Every restaurant has at least one branch (the "Main Branch" auto-created
 * at onboarding) even if multi-branch is never used, so this list is never
 * empty for a real restaurant.
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await ctx.params;
    const { restaurantId } = await resolveRestaurantContext(slug);

    const rows = await db
      .select()
      .from(branches)
      .where(eq(branches.restaurantId, restaurantId))
      .orderBy(asc(branches.createdAt));

    return NextResponse.json({ branches: rows });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Creates an additional branch. Gated MANAGE_BRANCHES — owner-only by
 * default (DEFAULT_ROLE_PERMISSIONS), the same "structural business
 * decision" trust tier as MANAGE_SUBSCRIPTION: opening a second physical
 * location isn't a day-to-day manager call. Plan-limited the same way
 * staff seats are (Phase 10) — a trial with no plan assigned yet gets the
 * generous TRIAL_MAX_BRANCHES default rather than blocking evaluation.
 */
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
      PERMISSIONS.MANAGE_BRANCHES,
    );

    const parsed = await parseJsonBody(request, createBranchSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const [restaurantRow] = await db
      .select({ planKey: restaurants.planKey })
      .from(restaurants)
      .where(eq(restaurants.id, restaurantId))
      .limit(1);
    const maxBranches = maxBranchesForRestaurant(restaurantRow ?? { planKey: null });
    if (maxBranches !== null) {
      const [branchCountRow] = await db
        .select({ n: count() })
        .from(branches)
        .where(and(eq(branches.restaurantId, restaurantId), eq(branches.isActive, true)));
      if ((branchCountRow?.n ?? 0) >= maxBranches) {
        return NextResponse.json(
          {
            error: `You've reached your plan's branch limit (${maxBranches}). Upgrade your plan from the Billing page to add more.`,
          },
          { status: 403 },
        );
      }
    }

    const [branch] = await db
      .insert(branches)
      .values({
        restaurantId,
        name: data.name,
        address: data.address && data.address.length > 0 ? data.address : null,
        city: data.city && data.city.length > 0 ? data.city : null,
        phone: data.phone && data.phone.length > 0 ? data.phone : null,
        isMain: false, // isMain is set once, at onboarding, and never reassigned here
      })
      .returning();

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "branches.created",
      resourceType: "branch",
      resourceId: branch.id,
      ipAddress: getClientIp(request),
      metadata: { name: branch.name },
    });

    return NextResponse.json({ branch }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
