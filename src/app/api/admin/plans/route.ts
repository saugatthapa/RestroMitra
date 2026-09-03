import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { plans } from "@/db/schema";
import { requirePlatformPermission } from "@/lib/rbac/guard";
import { PLATFORM_PERMISSIONS } from "@/lib/rbac/platform-permissions";
import { parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { createPlanSchema } from "@/lib/validation/plans";
import { getAllPlansForAdmin } from "@/lib/plans-db";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { rateLimit } from "@/lib/rate-limit";

/**
 * Platform Control Center (Phase 4) — the plan catalog's own management
 * endpoint. Gated VIEW_TENANTS to read (same tier as the restaurant list —
 * any platform role can see what plans exist) but MANAGE_PLANS to create,
 * matching PLATFORM_DEFAULT_ROLE_PERMISSIONS (billing_admin holds
 * MANAGE_PLANS; support_admin/platform_viewer don't).
 */
export async function GET() {
  try {
    const session = await requirePlatformPermission(PLATFORM_PERMISSIONS.VIEW_TENANTS);

    // QA hardening (P2 backlog) — see ai-providers/route.ts's matching
    // comment; shares the same admin-read:user bucket.
    const limit = await rateLimit(`admin-read:user:${session.user.id}`, { limit: 120, windowMs: 60 * 1000 });
    if (!limit.allowed) {
      return NextResponse.json({ error: "Too many requests. Please wait a moment." }, { status: 429 });
    }

    const allPlans = await getAllPlansForAdmin();
    return NextResponse.json({ plans: allPlans });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const session = await requirePlatformPermission(PLATFORM_PERMISSIONS.MANAGE_PLANS);

    const parsed = await parseJsonBody(request, createPlanSchema);
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;

    const existing = await db.select({ key: plans.key }).from(plans).where(eq(plans.key, data.key)).limit(1);
    if (existing.length > 0) {
      return NextResponse.json({ error: "A plan with this key already exists." }, { status: 409 });
    }

    const [plan] = await db
      .insert(plans)
      .values({
        key: data.key,
        name: data.name,
        tagline: data.tagline,
        priceInPaisaMonthly: data.priceInPaisaMonthly,
        maxStaff: data.maxStaff,
        maxBranches: data.maxBranches,
        highlight: data.highlight,
        features: data.features,
        featureKeys: data.featureKeys,
        aiMonthlyRequestLimit: data.aiMonthlyRequestLimit,
        sortOrder: data.sortOrder,
        isActive: data.isActive,
      })
      .returning();

    await recordAuditLog({
      restaurantId: null,
      userId: session.user.id,
      action: "plan.created",
      resourceType: "plan",
      resourceId: plan.key,
      ipAddress: getClientIp(request),
      metadata: { key: plan.key, name: plan.name, priceInPaisaMonthly: plan.priceInPaisaMonthly },
    });

    // See the matching comment in [planKey]/route.ts's PATCH handler — the
    // marketing pages that render this catalog are ISR-cached for up to an
    // hour, so a new plan needs the same explicit revalidation a plan edit
    // does, or it won't appear on the live site until the cache expires.
    revalidatePath("/");
    revalidatePath("/restaurant-pos-nepal");

    return NextResponse.json({ plan }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
