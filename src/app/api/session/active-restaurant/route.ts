import { NextResponse } from "next/server";
import { getSession, setActiveRestaurant } from "@/lib/auth/session";
import { getUserRestaurants } from "@/lib/restaurant";
import { getClientIp, hasValidCsrfHeader } from "@/lib/request";
import { recordAuditLog } from "@/lib/audit";

/**
 * Switches which restaurant this session's data is scoped to — the
 * server-side half of the header's restaurant switcher (DashboardShell).
 * Multi-restaurant ownership already existed (getUserRestaurants can
 * return more than one row, and every dashboard page already falls back
 * through `restaurants.find(r => r.id === session.activeRestaurantId)`)
 * but there was previously no UI path to actually change which one is
 * active — this closes that gap. `restaurantId` is only ever accepted if
 * it's one of *this* user's own active role grants, resolved server-side
 * via getUserRestaurants — never trusted blindly from the request body.
 */
export async function POST(request: Request) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const restaurantId = typeof body?.restaurantId === "string" ? body.restaurantId : null;
  if (!restaurantId) {
    return NextResponse.json({ error: "restaurantId is required." }, { status: 400 });
  }

  const restaurants = await getUserRestaurants(session.user.id);
  const target = restaurants.find((r) => r.id === restaurantId);
  if (!target) {
    return NextResponse.json({ error: "Restaurant not found." }, { status: 404 });
  }

  await setActiveRestaurant(session.sessionId, restaurantId);

  await recordAuditLog({
    restaurantId,
    userId: session.user.id,
    action: "session.switch_restaurant",
    resourceType: "restaurant",
    resourceId: restaurantId,
    ipAddress: getClientIp(request),
  });

  return NextResponse.json({ ok: true });
}
