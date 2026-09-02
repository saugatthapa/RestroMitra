import "server-only";
import { eq, and } from "drizzle-orm";
import { db } from "@/db";
import { userRoles, users } from "@/db/schema";
import { rateLimit } from "@/lib/rate-limit";

/**
 * Phase 25 — a true fallback alert channel for when Web Push categorically
 * can't reach anyone: VAPID isn't configured on this deployment yet, or
 * every subscribed device's subscription has expired. This is deliberately
 * NOT trying to detect "push was sent but the person didn't see it" — the
 * Push API gives no read receipt, so that's not something this app can ever
 * know. What it CAN know is "there is no one to push to right now," which
 * is exactly the situation where a new order or a table calling for help
 * would otherwise go completely unnoticed until the next time someone
 * happens to glance at a screen.
 *
 * Uses Resend's plain HTTP API directly (a single POST, no SDK) rather than
 * pulling in an email-sending dependency for what's meant to be a rare
 * fallback path. RESEND_API_KEY is optional — like VAPID, this degrades to
 * "no fallback email" (logged once) rather than breaking anything when
 * unset, since this is a bonus safety net, not a feature this app can
 * assume every deployment has configured.
 */
let notConfiguredLogged = false;

function isConfigured(): boolean {
  const configured = Boolean(process.env.RESEND_API_KEY);
  if (!configured && !notConfiguredLogged) {
    notConfiguredLogged = true;
    console.warn("email.ts: RESEND_API_KEY not set — email sending (push-fallback alerts, password reset links) is disabled.");
  }
  return configured;
}

/**
 * The one place that actually calls Resend's HTTP API — both
 * sendFallbackAlertEmail (below) and sendTransactionalEmail (Commercial
 * Launch Phase B.3) funnel through this, so there's exactly one
 * fetch-and-error-handling implementation to get right rather than two
 * copies drifting apart. Returns whether the send actually succeeded;
 * every caller in this file treats that as best-effort/fire-and-forget —
 * never something a request should fail over.
 */
async function postToResend(to: string, subject: string, text: string): Promise<boolean> {
  if (!isConfigured()) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: FROM_ADDRESS, to, subject, text }),
    });
    if (!res.ok) {
      console.error("email.ts: Resend API returned", res.status, await res.text().catch(() => ""));
      return false;
    }
    return true;
  } catch (err) {
    console.error("email.ts: send failed", err);
    return false;
  }
}

/** The restaurant's owner — the one person always accountable for the
 * account, and the natural inbox to land a "your notifications aren't
 * reaching anyone" alert in. Falls back to null (no-op) if the owner never
 * set an email on their account — phone number is the only field this app
 * requires at signup. */
async function getOwnerEmail(restaurantId: string): Promise<string | null> {
  const rows = await db
    .select({ email: users.email })
    .from(userRoles)
    .innerJoin(users, eq(userRoles.userId, users.id))
    .where(
      and(
        eq(userRoles.restaurantId, restaurantId),
        eq(userRoles.role, "owner"),
        eq(userRoles.isActive, true),
      ),
    )
    .limit(1);
  return rows[0]?.email ?? null;
}

const FROM_ADDRESS = process.env.RESEND_FROM_ADDRESS || "alerts@resend.dev";

/**
 * Sends a plain-text fallback alert email for `restaurantId`, rate-limited
 * to at most one every 10 minutes per restaurant — a busy dinner rush with
 * push broken should still notify the owner promptly without turning into
 * dozens of emails for dozens of orders. Best-effort and fire-and-forget
 * from the caller's perspective, same contract as sendPushToRestaurant:
 * this must never throw or delay the order/service-call write it's
 * reporting on.
 */
export async function sendFallbackAlertEmail(
  restaurantId: string,
  subject: string,
  body: string,
): Promise<void> {
  if (!isConfigured()) return;

  const cooldown = await rateLimit(`fallback-email:${restaurantId}`, {
    limit: 1,
    windowMs: 10 * 60 * 1000,
  });
  if (!cooldown.allowed) return;

  const to = await getOwnerEmail(restaurantId);
  if (!to) return;

  await postToResend(
    to,
    subject,
    `${body}\n\n— RestroKendra couldn't reach any device via push notification for this alert, so it's emailing you instead. Turn on notifications on a staff device to stop relying on this fallback.`,
  );
}

/**
 * Commercial Launch Phase B.3 (Forgot Password) — a plain "send this text
 * email to this address" helper, generalized out of the Resend fetch call
 * above rather than duplicating it. Unlike sendFallbackAlertEmail this has
 * no restaurant/owner lookup or built-in rate limit baked in — the
 * forgot-password route does its own IP+phone rate limiting (mirroring
 * login's), which is the right place to bound *reset request* volume; this
 * helper's only job is the actual send. Same degrade-to-no-op-if-
 * unconfigured contract as every other email path in this file. The
 * returned boolean is for logging only — a caller must never let it leak
 * into a user-facing response, since that would reveal whether a given
 * address is on file (see the route's own comment on generic responses).
 */
export async function sendTransactionalEmail(to: string, subject: string, text: string): Promise<boolean> {
  return postToResend(to, subject, text);
}
