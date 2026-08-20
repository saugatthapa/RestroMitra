# Why a staff phone might not get order notifications

You confirmed push is technically working (VAPID configured, subscription
saved, test button reports "sent"). If notifications still don't actually
show up on a phone — especially with the app fully closed — the cause is
almost always **the phone's own battery/background settings**, not the app.
This is extremely common on Android in Nepal specifically because the most
popular budget/mid-range brands (Xiaomi/Redmi, Vivo, Oppo) are notorious for
aggressively killing background apps to save battery — independent of
whether you granted notification permission.

Do this **once per staff phone** that needs to receive alerts:

## Android — Xiaomi / Redmi (MIUI)

1. Settings → Apps → Manage apps → **Chrome** (or whichever browser you
   installed the app through) → Battery saver → set to **No restrictions**.
2. Settings → Apps → Manage apps → Chrome → **Autostart** → turn **ON**.
3. Open Recent Apps (square button), find Chrome, swipe down (not up) or
   tap the lock icon to **lock it** so the system won't clear it.
4. Security app → Battery → Autostart → make sure Chrome / RestroMitra is
   allowed.

## Android — Vivo (FuntouchOS/OriginOS)

1. Settings → Battery → Background power consumption management → find
   Chrome → allow **background activity**.
2. i Manager (Vivo's built-in app) → App manager → Autostart → enable for
   Chrome.

## Android — Oppo (ColorOS)

1. Settings → Battery → find Chrome → **Allow background activity**.
2. Settings → Privacy permissions → Startup manager → enable Chrome.

## Android — Samsung / stock Android / other brands

1. Settings → Apps → Chrome → Battery → set to **Unrestricted** (not
   "Optimized," not "Restricted").
2. Make sure **Do Not Disturb** isn't silencing notifications during work
   hours, and that Chrome's own notification channel for this site isn't
   muted (Settings → Apps → Chrome → Notifications).

## iPhone / iPad

Apple only allows web push to an app that was **installed to the Home
Screen and opened from that icon** — never from a regular Safari tab, no
matter what permission you grant there. Requires iOS 16.4+. In Safari:
Share icon → **Add to Home Screen** → then always open RestroMitra from
that new icon, not from Safari itself. The app now shows a banner
reminding staff of this automatically when it detects an iPhone/iPad that
hasn't done this yet.

## After changing any of the above

Reopen the dashboard, wait a few seconds, then use the **"Send test
notification"** button (appears once permission is granted, near the top
of the dashboard) to confirm. If it says "sent" but you still don't see
anything after checking the settings above, tell me exactly what device/
OS it is and I'll dig further.

## What the app itself already does

- Sends every push with `urgency: high` and a short TTL, which asks the
  push service (and, on stock Android, the OS's power management) to
  prioritize and not queue it — a real improvement, but it can't override
  an OEM's own background-killing of the browser.
- Falls back to an in-app alarm (works whenever a dashboard tab/PWA window
  is open, independent of push) and, if push can't reach anyone at all
  (misconfigured or zero subscriptions), an email to the owner — see
  PERFORMANCE_AUDIT.md and this session's other notes for detail.
- Cannot, and no web app can, override a phone's own OS-level battery
  management — this is a real platform limitation, not a bug specific to
  this app. The device settings above are the actual fix.
