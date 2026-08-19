import "server-only";
import webpush from "web-push";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { pushSubscriptions } from "@/db/schema";

/**
 * Phase 25 — Web Push send path. This is what makes a new-order alert show
 * up as a real system notification even when the dashboard/PWA is
 * completely closed on staff's phone, not just backgrounded — the gap the
 * older in-page `new Notification(...)` call (still in DashboardShell for
 * an open-tab tab) can never close, since that code only runs while the
 * page is alive.
 *
 * VAPID keys are read lazily (not at module load) so a deployment that
 * hasn't set them yet doesn't crash on import — every route that imports
 * this module (including ones unrelated to push) would otherwise fail to
 * build/start. `configured` is checked before every send; when unset,
 * `sendPushToRestaurant` is a silent no-op (logged once) rather than a
 * thrown error, since a missing push config should degrade the app to
 * "no push notifications," never take down order creation itself.
 */
let configured = false;
function ensureConfigured(): boolean {
  if (configured) return true;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) {
    return false;
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
  return true;
}

/** Exposed to the client-side subscribe flow via a small API route — the
 * private key never leaves this module. */
export function getVapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY ?? null;
}

export type PushPayload = {
  title: string;
  body: string;
  /** Where notificationclick in the service worker should navigate to. */
  url: string;
  tag?: string;
};

/**
 * Sends `payload` as a push notification to every device subscribed for
 * `restaurantId`. Best-effort and fire-and-forget from the caller's
 * perspective — a push failure must never fail the order/service-call
 * write it's reporting on, so every error is caught and logged here rather
 * than thrown. A 404/410 response means the push service itself says this
 * subscription is gone (browser uninstalled, permission revoked, endpoint
 * rotated) — those rows are deleted so this list doesn't grow stale
 * forever; any other error (network blip, 5xx) leaves the row alone since
 * it may well succeed next time.
 */
export async function sendPushToRestaurant(restaurantId: string, payload: PushPayload): Promise<void> {
  if (!ensureConfigured()) {
    console.warn("sendPushToRestaurant: VAPID keys not configured, skipping push send.");
    return;
  }

  const subs = await db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.restaurantId, restaurantId));

  if (subs.length === 0) return;

  const body = JSON.stringify(payload);

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          body,
        );
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id));
        } else {
          console.error("Push send failed for subscription", sub.id, err);
        }
      }
    }),
  );
}
