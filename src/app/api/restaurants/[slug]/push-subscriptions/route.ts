import { NextResponse } from "next/server";
import { db } from "@/db";
import { pushSubscriptions } from "@/db/schema";
import { resolveRestaurantContext, parseJsonBody, toErrorResponse } from "@/lib/api-route-helpers";
import { getVapidPublicKey } from "@/lib/push";
import { savePushSubscriptionSchema } from "@/lib/validation/push";
import { hasValidCsrfHeader } from "@/lib/request";

/**
 * Phase 25 — Web Push subscription endpoint.
 *
 * GET returns the VAPID public key NotificationPermissionGate needs to call
 * `pushManager.subscribe({applicationServerKey: ...})` — kept behind auth
 * (not a bare NEXT_PUBLIC_ env var) so it's read at request time from
 * whatever the host's actual runtime env has set, rather than baked in at
 * `next build` time, which matters on Hostinger where the build and the
 * env-var-setting step can happen at different points in the deploy flow.
 * `configured: false` tells the client there's nothing to subscribe to yet
 * (owner hasn't set VAPID_* on this deployment) rather than the client
 * discovering that only when subscribe() itself fails.
 *
 * POST saves (or refreshes) one subscription for the signed-in user's
 * current device/browser. Upserts by `endpoint` — see the schema comment on
 * pushSubscriptions for why that's the natural conflict target.
 */
export async function GET(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    await resolveRestaurantContext(slug);
    const publicKey = getVapidPublicKey();
    return NextResponse.json({ configured: Boolean(publicKey), publicKey });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  if (!hasValidCsrfHeader(request)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { slug } = await ctx.params;
    const { session, restaurantId } = await resolveRestaurantContext(slug);

    const parsed = await parseJsonBody(request, savePushSubscriptionSchema);
    if (!parsed.ok) return parsed.response;
    const { endpoint, keys } = parsed.data;

    const userAgent = request.headers.get("user-agent");

    await db
      .insert(pushSubscriptions)
      .values({
        restaurantId,
        userId: session.user.id,
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
        userAgent,
      })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: {
          restaurantId,
          userId: session.user.id,
          p256dh: keys.p256dh,
          auth: keys.auth,
          userAgent,
          updatedAt: new Date(),
        },
      });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
