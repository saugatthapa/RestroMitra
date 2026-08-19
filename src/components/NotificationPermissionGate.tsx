"use client";

import { useEffect, useState } from "react";

const SNOOZE_KEY = "dhankipos:notif-gate-snoozed"; // sessionStorage — reappears next session, not gone forever

function isNotificationSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

/**
 * Phase 23 (order-alert reliability) — staff kept missing new orders because
 * nothing ever asked for browser notification permission, so the "ding"
 * DashboardShell plays on order.created had no way to also raise a system
 * notification when the dashboard tab wasn't focused (a switched tab, a
 * minimized window, a different app entirely on the POS tablet/phone).
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
export function NotificationPermissionGate() {
  const [supported, setSupported] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission>("default");
  const [dismissedThisSession, setDismissedThisSession] = useState(false);
  const [requesting, setRequesting] = useState(false);

  useEffect(() => {
    if (!isNotificationSupported()) return;
    setSupported(true);
    setPermission(Notification.permission);
    setDismissedThisSession(window.sessionStorage.getItem(SNOOZE_KEY) === "1");
  }, []);

  async function enable() {
    if (!isNotificationSupported()) return;
    setRequesting(true);
    try {
      const result = await Notification.requestPermission();
      setPermission(result);
    } finally {
      setRequesting(false);
    }
  }

  function dismiss() {
    setDismissedThisSession(true);
    window.sessionStorage.setItem(SNOOZE_KEY, "1");
  }

  if (!supported || permission === "granted") return null;

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
