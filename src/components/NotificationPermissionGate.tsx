"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api-client";

const SNOOZE_KEY = "restromitra:notif-gate-snoozed"; // sessionStorage — reappears next session, not gone forever
const TEST_DISMISS_KEY = "restromitra:notif-test-dismissed"; // sessionStorage — same "reappears next session" idea

type TestOutcome =
  | { status: "not_configured" }
  | { status: "no_subscription" }
  | { status: "sent"; results: { ok: boolean; expired?: boolean }[] }
  | { status: "error" };

function isNotificationSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

function isPushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window;
}

// iPhone/iPad detection — deliberately simple regex + the iPadOS-masquerades-
// as-desktop-Safari fallback (iPadOS 13+ reports as "MacIntel" with no
// touch-point signal in the UA string itself, so touch points is the only
// reliable tell). Good enough for "should we show the install-first hint,"
// not meant to be bulletproof device fingerprinting.
function isIOS(): boolean {
  if (typeof window === "undefined") return false;
  const ua = window.navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return window.navigator.platform === "MacIntel" && window.navigator.maxTouchPoints > 1;
}

// Apple only turns on the Push API (and, in practice, reliable background
// delivery at all) once the site is launched from a Home Screen icon, not a
// regular Safari tab — confirmed via research into current (2025-2026) iOS
// Web Push behavior. `navigator.standalone` is Safari's own non-standard
// property for exactly this; the matchMedia check is the standardized
// equivalent other engines use. Requesting permission from inside a normal
// Safari tab on iOS either silently does nothing useful or leaves staff
// thinking they're covered when they're not — worth detecting explicitly
// rather than showing the same "Turn on notifications" button that works
// fine on Android/desktop.
function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return window.matchMedia("(display-mode: standalone)").matches || nav.standalone === true;
}

// Converts a URL-safe base64 VAPID public key (what web-push's
// generateVAPIDKeys produces, and what the GET below returns) into the raw
// Uint8Array pushManager.subscribe's applicationServerKey option requires —
// the Push API spec takes only that binary form, never the base64 string
// directly.
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

/**
 * Subscribes this browser/device to Web Push (if not already subscribed
 * with a still-valid subscription) and saves it server-side. Safe to call
 * opportunistically on every mount once permission is already "granted" —
 * `pushManager.subscribe()` returns the existing subscription instead of
 * creating a duplicate when one is already active, and the save route
 * upserts by endpoint — so this is cheap even when it's a no-op.
 */
async function subscribeAndSave(slug: string): Promise<void> {
  if (!isPushSupported()) return;

  const keyRes = await apiGet<{ configured: boolean; publicKey: string | null }>(
    `/api/restaurants/${slug}/push-subscriptions`,
  );
  if (!keyRes.configured || !keyRes.publicKey) return; // deployment hasn't set VAPID_* yet

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(keyRes.publicKey) as BufferSource,
  });
  const json = subscription.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return;

  await apiPost(`/api/restaurants/${slug}/push-subscriptions`, {
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  });
}

/**
 * Phase 23 (order-alert reliability) — staff kept missing new orders because
 * nothing ever asked for browser notification permission, so the "ding"
 * DashboardShell plays on order.created had no way to also raise a system
 * notification when the dashboard tab wasn't focused (a switched tab, a
 * minimized window, a different app entirely on the POS tablet/phone).
 *
 * Phase 25 — granting permission here now also drives an actual Web Push
 * subscription (see subscribeAndSave above, src/lib/push.ts, and
 * public/dashboard-sw.js's `push` handler), which is what lets a new-order
 * alert reach staff even when the app/PWA is completely closed, not just
 * backgrounded — permission alone was never enough for that; the in-page
 * `Notification` API this gate originally only requested permission for
 * can't fire at all once nothing is running.
 *
 * A browser gives no way to truly *force* a permission grant — only a user
 * gesture can open the native prompt, and once someone taps "Block" the page
 * can never re-prompt them again (browsers hard-block that on purpose, to
 * stop exactly the kind of nagging this feature risks becoming). So "force"
 * here means: a hard-to-miss banner, worded around the concrete cost of
 * staying off ("you will miss orders"), that reappears every fresh session
 * until a choice is made — dismissing it is a `sessionStorage` snooze, not a
 * permanent one, so closing it today doesn't silence it for good tomorrow.
 */
export function NotificationPermissionGate({ slug }: { slug: string }) {
  const [supported, setSupported] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission>("default");
  const [dismissedThisSession, setDismissedThisSession] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [testDismissed, setTestDismissed] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testOutcome, setTestOutcome] = useState<TestOutcome | null>(null);
  const [iosNeedsInstall, setIosNeedsInstall] = useState(false);

  useEffect(() => {
    setIosNeedsInstall(isIOS() && !isStandalone());
    if (!isNotificationSupported()) return;
    setSupported(true);
    setPermission(Notification.permission);
    setDismissedThisSession(window.sessionStorage.getItem(SNOOZE_KEY) === "1");
    setTestDismissed(window.sessionStorage.getItem(TEST_DISMISS_KEY) === "1");
  }, []);

  async function runTest() {
    setTesting(true);
    setTestOutcome(null);
    try {
      const outcome = await apiPost<TestOutcome>(`/api/restaurants/${slug}/push-subscriptions/test`, {});
      setTestOutcome(outcome);
    } catch {
      setTestOutcome({ status: "error" });
    } finally {
      setTesting(false);
    }
  }

  function dismissTest() {
    setTestDismissed(true);
    window.sessionStorage.setItem(TEST_DISMISS_KEY, "1");
  }

  // Opportunistic re-subscribe: covers both "permission was already granted
  // in an earlier session, before Web Push existed here" and "the OS/
  // browser silently invalidated a previous subscription" (endpoint
  // rotation, browser data cleared, etc.) — either way, every mount with
  // permission already granted quietly ensures a live subscription exists
  // without needing staff to click anything again.
  useEffect(() => {
    if (typeof window === "undefined" || Notification.permission !== "granted") return;
    subscribeAndSave(slug).catch(() => {
      // Best-effort — the ding/in-tab alerting still works regardless of
      // whether push subscribing succeeds.
    });
  }, [slug]);

  async function enable() {
    if (!isNotificationSupported()) return;
    setRequesting(true);
    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result === "granted") {
        await subscribeAndSave(slug).catch(() => {
          // Permission granted is still worth keeping even if the push
          // subscribe step itself failed (e.g. transient network error) —
          // the opportunistic effect above will retry on next mount.
        });
      }
    } finally {
      setRequesting(false);
    }
  }

  function dismiss() {
    setDismissedThisSession(true);
    window.sessionStorage.setItem(SNOOZE_KEY, "1");
  }

  // iOS/iPadOS in a regular Safari tab: Notification/PushManager may not
  // even be present here (isNotificationSupported() below would just
  // return null silently), so this has to be checked first and shown
  // regardless — the fix is a completely different action (install to
  // Home Screen) from the "tap this button" flow everywhere else.
  if (iosNeedsInstall) {
    if (dismissedThisSession) return null;
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-orange-200 bg-orange-50 px-4 py-2.5 text-xs font-medium text-orange-900 md:px-6">
        <span className="flex items-center gap-1.5">
          <span className="text-sm" aria-hidden="true">
            📲
          </span>
          On iPhone/iPad, order notifications only work after adding this to your Home Screen: tap the Share
          icon, then &quot;Add to Home Screen,&quot; and open RestroMitra from that icon instead of Safari.
        </span>
        <button
          type="button"
          onClick={dismiss}
          className="rounded-full px-2 py-1.5 text-xs font-medium text-orange-700 hover:bg-orange-100"
        >
          Not now
        </button>
      </div>
    );
  }

  if (!supported) return null;

  // Permission is granted, meaning the loud "please turn this on" banner
  // below has done its job — but that alone doesn't prove a push actually
  // reaches this device (VAPID misconfiguration, a subscribe() that failed
  // silently, etc. — see sendTestPush's doc comment in lib/push.ts for the
  // three distinct ways this can be broken). A one-line, easy-to-ignore
  // "Test" control replaces the banner here instead of just going silent,
  // since a false "everything's fine" is worse than a small persistent
  // affordance to actually check.
  if (permission === "granted") {
    if (testDismissed) return null;
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-200 bg-neutral-50 px-4 py-1.5 text-[11px] text-neutral-500 md:px-6">
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-green-500" aria-hidden="true" />
          Notifications are on for this device.
          {testOutcome?.status === "sent" &&
            (testOutcome.results.some((r) => r.ok)
              ? " Test sent — check for it now."
              : testOutcome.results.some((r) => r.expired)
                ? " Your subscription expired — reload this page to renew it, then try again."
                : " Send failed — see below.")}
          {testOutcome?.status === "not_configured" &&
            " Push isn't configured on this deployment yet (VAPID_* env vars)."}
          {testOutcome?.status === "no_subscription" &&
            " No subscription found for this device — try reloading the page."}
          {testOutcome?.status === "error" && " Couldn't reach the server — try again."}
        </span>
        <span className="flex items-center gap-2">
          <button
            type="button"
            onClick={runTest}
            disabled={testing}
            className="rounded-full border border-neutral-300 px-2.5 py-1 font-medium text-neutral-700 hover:bg-neutral-100 disabled:opacity-50"
          >
            {testing ? "Sending…" : "Send test notification"}
          </button>
          <button type="button" onClick={dismissTest} className="px-1 py-1 text-neutral-400 hover:text-neutral-600">
            ✕
          </button>
        </span>
      </div>
    );
  }

  if (permission === "denied") {
    return (
      <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-xs font-medium text-red-800 md:px-6">
        <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-red-500" aria-hidden="true" />
        Notifications are blocked — you won&apos;t be alerted about new orders when this tab isn&apos;t open. Turn
        them back on from your browser&apos;s site settings (tap the lock/info icon next to the address bar).
      </div>
    );
  }

  if (dismissedThisSession) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-orange-200 bg-orange-50 px-4 py-2.5 text-xs font-medium text-orange-900 md:px-6">
      <span className="flex items-center gap-1.5">
        <span className="text-sm" aria-hidden="true">
          🔔
        </span>
        Turn on notifications so you never miss an order — orders can come in while you&apos;re on another tab, app,
        or screen.
      </span>
      <span className="flex items-center gap-2">
        <button
          type="button"
          onClick={enable}
          disabled={requesting}
          className="rounded-full bg-orange-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-orange-700 disabled:opacity-50"
        >
          {requesting ? "Requesting…" : "Turn on notifications"}
        </button>
        <button
          type="button"
          onClick={dismiss}
          className="rounded-full px-2 py-1.5 text-xs font-medium text-orange-700 hover:bg-orange-100"
        >
          Not now
        </button>
      </span>
    </div>
  );
}
