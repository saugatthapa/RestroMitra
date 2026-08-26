import { NextResponse } from "next/server";
import { db } from "@/db";
import { createRestaurantSchema } from "@/lib/validation/onboarding";
import { requireAuth } from "@/lib/rbac/guard";
import { setActiveRestaurant } from "@/lib/auth/session";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { createRestaurantOnboarding } from "@/lib/onboarding";
import { toErrorResponse } from "@/lib/api-route-helpers";

// QA hardening (P2 backlog): this route used to hand-roll its own
// AuthError-only try/catch around just the requireAuth() call, instead of
// the shared toErrorResponse used everywhere else in this app —
// AuthError already extends HttpError (see rbac/guard.ts), so
// toErrorResponse handles it identically, and wrapping the WHOLE handler
// (not just requireAuth) additionally gives every other unexpected
// failure below the same consistent JSON shape + Sentry reporting as
// every other route, with no change to any explicit return path.
export async function POST(request: Request) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    return await handleCreateRestaurant(request);
  } catch (err) {
    return toErrorResponse(err);
  }
}

async function handleCreateRestaurant(request: Request) {
  const session = await requireAuth();

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

  const result = await createRestaurantOnboarding(db, {
    name: data.name,
    type: data.type,
    address: data.address,
    city: data.city,
    district: data.district,
    phone: data.phone,
    panVat: data.panVat,
    logoUrl: data.logoUrl,
    openTime: data.openTime,
    closeTime: data.closeTime,
    ownerUserId: session.user.id,
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
