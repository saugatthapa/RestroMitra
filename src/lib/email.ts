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
    console.warn("sendFallbackAlertEmail: RESEND_API_KEY not set, skipping email fallback.");
  }
  return configured;
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

  const cooldown = rateLimit(`fallback-email:${restaurantId}`, {
    limit: 1,
    windowMs: 10 * 60 * 1000,
  });
  if (!cooldown.allowed) return;

  try {
    const to = await getOwnerEmail(restaurantId);
    if (!to) return;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to,
        subject,
        text: `${body}\n\n— RestroMitra couldn't reach any device via push notification for this alert, so it's emailing you instead. Turn on notifications on a staff device to stop relying on this fallback.`,
      }),
    });
    if (!res.ok) {
      console.error("sendFallbackAlertEmail: Resend API returned", res.status, await res.text().catch(() => ""));
    }
  } catch (err) {
    console.error("sendFallbackAlertEmail failed", err);
  }
}
