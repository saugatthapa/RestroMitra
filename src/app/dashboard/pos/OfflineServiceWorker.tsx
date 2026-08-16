"use client";

import { useEffect } from "react";

/**
 * Registers public/pos-sw.js scoped to /dashboard/pos/ only. Renders
 * nothing — this is a side-effect-only component, mounted once alongside
 * POSOrderBuilder so the service worker (and therefore offline reload
 * support) is only ever active while a staff member actually has the POS
 * page open, never sitewide.
 */
export function OfflineServiceWorker() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/pos-sw.js", { scope: "/dashboard/pos/" }).catch(() => {
      // Offline support degrades gracefully without a service worker — the
      // menu snapshot (localStorage) and order queue (IndexedDB) still
      // work; only a full page reload while offline would be affected.
    });
  }, []);

  return null;
}
