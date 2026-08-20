import "server-only";
import webpush from "web-push";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { pushSubscriptions } from "@/db/schema";
import { sendFallbackAlertEmail } from "@/lib/email";

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
// Set once setVapidDetails has thrown — an invalid key is a deployment
// misconfiguration that won't fix itself on the next request, so there's no
// point re-attempting (and re-logging the same error) on every single order.
let configFailed = false;
function ensureConfigured(): boolean {
  if (configured) return true;
  if (configFailed) return false;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) {
    return false;
  }
  // `sendPushToRestaurant` is always called with `void` (fire-and-forget) so
  // an order/service-call write is never blocked by a slow push send — but
  // that also means an exception thrown here has no caller left to catch
  // it, and surfaces as an unhandled promise rejection instead. web-push's
  // setVapidDetails() throws synchronously on a malformed key (wrong
  // length, extra whitespace pasted in, a PEM-wrapped key instead of the
  // raw base64url string, etc.) — a real and easy mistake to make copying
  // keys into a hosting panel by hand — so this must never be allowed to
  // escape uncaught.
  try {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    configured = true;
    return true;
  } catch (err) {
    configFailed = true;
    console.error(
      "sendPushToRestaurant: VAPID_* env vars are set but invalid (setVapidDetails threw) — push notifications are disabled until this is fixed. Re-check the keys were pasted in exactly as generated, with no extra whitespace.",
      err,
    );
    return false;
  }
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

export type PushSendResult = {
  subscriptionId: string;
  ok: boolean;
  /** True when the push service itself said the subscription is gone
   * (404/410) — expected/benign, not a config problem. */
  expired?: boolean;
  error?: string;
};

/** Shared send loop — same delivery + stale-subscription cleanup for every
 * caller, whether it's a fire-and-forget restaurant-wide alert or an
 * awaited single-device test send. */
async function sendToSubscriptions(
  subs: (typeof pushSubscriptions.$inferSelect)[],
  payload: PushPayload,
): Promise<PushSendResult[]> {
  const body = JSON.stringify(payload);

  return Promise.all(
    subs.map(async (sub): Promise<PushSendResult> => {
      try {
        // urgency "high" + a short TTL: an order/service-call alert is
        // time-sensitive and worthless once stale, so this asks the push
        // service (and, on Android, the OS's Doze/App-Standby power
        // management) to wake the device promptly rather than batching
        // this with other low-priority background traffic — the default
        // is "normal", which on battery-constrained devices can sit queued
        // for minutes. TTL of 1 hour: if a device is offline longer than
        // that, "new order from an hour ago" isn't useful to deliver late
        // anyway, and letting it expire keeps the push service from
        // holding/retrying it indefinitely. See PERFORMANCE_AUDIT.md-
        // adjacent notification research for why urgency doesn't fix
        // OEM-level background killing (Xiaomi/Vivo/Oppo etc.) — that's a
        // device-settings problem this can't solve — but it's a real,
        // free win on stock Android/Chrome.
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          body,
          { urgency: "high", TTL: 3600 },
        );
        return { subscriptionId: sub.id, ok: true };
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id));
          return { subscriptionId: sub.id, ok: false, expired: true, error: "Subscription expired." };
        }
        console.error("Push send failed for subscription", sub.id, err);
        return {
          subscriptionId: sub.id,
          ok: false,
          error: err instanceof Error ? err.message : "Unknown error",
        };
      }
    }),
  );
}

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
 *
 * When push categorically can't reach anyone right now — VAPID was never
 * configured on this deployment, or there's simply no live subscription —
 * this falls back to emailing the restaurant's owner (see lib/email.ts)
 * rather than the alert going out into the void with nobody ever knowing.
 * That fallback is deliberately NOT attempted when individual sends fail
 * despite subscriptions existing (a transient push-service 5xx, say) —
 * only the two "there is definitionally no one to push to" cases below.
 */
export async function sendPushToRestaurant(restaurantId: string, payload: PushPayload): Promise<void> {
  if (!ensureConfigured()) {
    console.warn("sendPushToRestaurant: VAPID keys not configured, skipping push send.");
    void sendFallbackAlertEmail(restaurantId, payload.title, payload.body);
    return;
  }

  const subs = await db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.restaurantId, restaurantId));

  if (subs.length === 0) {
    void sendFallbackAlertEmail(restaurantId, payload.title, payload.body);
    return;
  }

  await sendToSubscriptions(subs, payload);
}

export type TestPushOutcome =
  | { status: "not_configured" }
  | { status: "no_subscription" }
  | { status: "sent"; results: PushSendResult[] };

/**
 * "Send me a test notification" — lets a staff member (and, more
 * importantly, an owner deploying this for the first time) verify their OWN
 * device's push chain end to end without needing anyone to read server
 * logs. Distinguishes the three ways this can be broken, since they need
 * completely different fixes:
 *   - not_configured: VAPID_* isn't set (or is invalid) on this deployment
 *     — a hosting-panel/env-var problem, not a code bug.
 *   - no_subscription: VAPID is fine, but this device never subscribed —
 *     check that notification permission was actually granted on THIS
 *     device/browser (see NotificationPermissionGate).
 *   - sent: a push was actually dispatched to the push service; `results`
 *     reports per-subscription success (delivery beyond that is outside
 *     this app's visibility — the OS/browser takes it from here).
 */
export async function sendTestPush(userId: string): Promise<TestPushOutcome> {
  if (!ensureConfigured()) return { status: "not_configured" };

  const subs = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
  if (subs.length === 0) return { status: "no_subscription" };

  const results = await sendToSubscriptions(subs, {
    title: "Test notification",
    body: "If you can see this, push notifications are working on this device.",
    url: "/dashboard",
    tag: "dhankipos-test",
  });
  return { status: "sent", results };
}
