import { NextResponse } from "next/server";
import { db } from "@/db";
import { createRestaurantSchema } from "@/lib/validation/onboarding";
import { requireAuth, AuthError } from "@/lib/rbac/guard";
import { setActiveRestaurant } from "@/lib/auth/session";
import { recordAuditLog } from "@/lib/audit";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { createRestaurantOnboarding } from "@/lib/onboarding";

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
