import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { chartOfAccounts, restaurants } from "@/db/schema";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { resolveRestaurantContext, toErrorResponse } from "@/lib/api-route-helpers";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { HttpError } from "@/lib/http-error";

/**
 * Phase 4 — the one-time, explicit switch that turns on automatic
 * posting (order completion, payments, expenses, ... — see
 * ACCOUNTING_PHASE_4_PLAN.md Part 1). Deliberately a SEPARATE action from
 * seeding the chart of accounts (the `seed` route above): a restaurant
 * should be able to explore the new Accounting screen, set up its chart of
 * accounts, and look around without any of that silently changing how the
 * POS itself behaves. Requires a chart of accounts to already exist, since
 * every Phase 4 posting resolves account_mappings that only exist once
 * seeded.
 *
 * There is deliberately no corresponding "disable" route — see the
 * automaticPostingEnabledAt column's own comment in schema.ts for why
 * turning it back off mid-flight would leave the books in a worse state
 * (some events posted, some not) than either extreme.
 */
export async function POST(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(
      slug,
      PERMISSIONS.MANAGE_ACCOUNTING,
    );

    const [existingAccount] = await db
      .select({ id: chartOfAccounts.id })
      .from(chartOfAccounts)
      .where(eq(chartOfAccounts.restaurantId, restaurantId))
      .limit(1);
    if (!existingAccount) {
      throw new HttpError("Set up the Chart of Accounts before enabling automatic posting.");
    }

    const [restaurant] = await db
      .select({ automaticPostingEnabledAt: restaurants.automaticPostingEnabledAt })
      .from(restaurants)
      .where(eq(restaurants.id, restaurantId))
      .limit(1);
    if (restaurant?.automaticPostingEnabledAt) {
      return NextResponse.json({ automaticPostingEnabledAt: restaurant.automaticPostingEnabledAt });
    }

    const now = new Date();
    await db.update(restaurants).set({ automaticPostingEnabledAt: now }).where(eq(restaurants.id, restaurantId));

    await recordAuditLog({
      restaurantId,
      userId: session.user.id,
      action: "accounting.automatic_posting_enabled",
      resourceType: "restaurant",
      resourceId: restaurantId,
      ipAddress: getClientIp(request),
    });

    return NextResponse.json({ automaticPostingEnabledAt: now });
  } catch (err) {
    return toErrorResponse(err);
  }
}
