import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { restaurants, branches, userRoles } from "@/db/schema";
import { createRestaurantSchema } from "@/lib/validation/onboarding";
import { requireAuth, AuthError } from "@/lib/rbac/guard";
import { setActiveRestaurant } from "@/lib/auth/session";
import { recordAuditLog } from "@/lib/audit";
import { recordSubscriptionEvent } from "@/lib/subscription-db";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { slugify, randomSuffix } from "@/lib/slug";
import { seedDefaultExpenseCategories } from "@/lib/expense-categories";

const DAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

export async function POST(request: Request) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  let session;
  try {
    session = await requireAuth();
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  const body = await request.json().catch(() => null);
  const parsed = createRestaurantSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input." },
      { status: 400 },
    );
  }

  const data = parsed.data;
  const ip = getClientIp(request);

  const baseSlug = slugify(data.name) || "restaurant";
  let slug = baseSlug;
  for (let attempt = 0; attempt < 5; attempt++) {
    const collision = await db
      .select({ id: restaurants.id })
      .from(restaurants)
      .where(eq(restaurants.slug, slug))
      .limit(1);
    if (collision.length === 0) break;
    slug = `${baseSlug}-${randomSuffix()}`;
  }

  const openingHours = Object.fromEntries(
    DAYS.map((day) => [day, { open: data.openTime, close: data.closeTime }]),
  );

  const trialEndsAt = new Date();
  trialEndsAt.setDate(trialEndsAt.getDate() + 30);

  const result = await db.transaction(async (tx) => {
    const [restaurant] = await tx
      .insert(restaurants)
      .values({
        slug,
        name: data.name,
        type: data.type,
        address: data.address,
        city: data.city,
        district: data.district,
        phone: data.phone,
        panVat: data.panVat && data.panVat.length > 0 ? data.panVat : null,
        logoUrl: data.logoUrl && data.logoUrl.length > 0 ? data.logoUrl : null,
        openingHours,
        onboardingStep: 8,
        subscriptionStatus: "trialing",
        trialEndsAt,
      })
      .returning({ id: restaurants.id, slug: restaurants.slug });

    const [branch] = await tx
      .insert(branches)
      .values({
        restaurantId: restaurant.id,
        name: `${data.name} — Main Branch`,
        address: data.address,
        city: data.city,
        phone: data.phone,
        isMain: true,
      })
      .returning({ id: branches.id });

    await tx.insert(userRoles).values({
      userId: session.user.id,
      restaurantId: restaurant.id,
      branchId: null, // owner: unrestricted across all branches
      role: "owner",
    });

    await recordSubscriptionEvent(tx, {
      restaurantId: restaurant.id,
      eventType: "trial_started",
      toStatus: "trialing",
      note: "30-day free trial started at signup.",
      performedByUserId: session.user.id,
    });

    await seedDefaultExpenseCategories(tx, restaurant.id);

    return { restaurant, branch };
  });

  await setActiveRestaurant(session.sessionId, result.restaurant.id);

  await recordAuditLog({
    restaurantId: result.restaurant.id,
    userId: session.user.id,
    action: "restaurant.created",
    resourceType: "restaurant",
    resourceId: result.restaurant.id,
    ipAddress: ip,
    metadata: { slug: result.restaurant.slug },
  });

  return NextResponse.json(
    { ok: true, slug: result.restaurant.slug },
    { status: 201 },
  );
}
