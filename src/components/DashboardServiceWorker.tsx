"use client";

import { useEffect } from "react";

/**
 * Registers public/dashboard-sw.js scoped to /dashboard/ — mounted once in
 * DashboardShell (Phase 22) so every dashboard page, not just POS (Phase
 * 11b's original scope), gets runtime GET caching for offline resilience.
 * Renders nothing — this is a side-effect-only component. See
 * dashboard-sw.js's own header comment for the caching strategy.
 */
export function DashboardServiceWorker() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/dashboard-sw.js", { scope: "/dashboard/" }).catch(() => {
      // Offline support degrades gracefully without a service worker — each
      // page's own localStorage snapshot / IndexedDB queue still works;
      // only a full page reload while offline would be affected.
    });
  }, []);

  return null;
}
