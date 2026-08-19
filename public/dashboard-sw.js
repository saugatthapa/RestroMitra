// Phase 11b (POS) / Phase 22 (offline mode) — dashboard shell service worker.
//
// Originally registered only for /dashboard/pos (as pos-sw.js); Phase 22
// broadens it to the whole dashboard — see
// src/components/DashboardServiceWorker.tsx, scope: "/dashboard/" — so a
// hard reload of the Orders board or KDS while offline still shows
// whatever was last successfully fetched, the same way POS already could.
// It never touches any page OUTSIDE /dashboard (login, the public QR order
// page, billing, etc. are untouched) — a stale cached response on, say, a
// subscription-gated redirect would be a real bug there, not a convenience.
//
// Within its scope it's a plain network-falling-back-to-cache strategy:
// every successful same-origin GET response is cached, and if a later
// request for the same URL fails outright (no connectivity), the cached
// copy is served instead. This is what keeps a dashboard page — its
// HTML/JS/CSS bundle, and its own GET API calls (menu, tables, orders,
// tickets) — usable across a hard reload while offline, on top of
// whatever page-specific localStorage snapshot / IndexedDB queue that
// page's own code keeps (see src/lib/offline-queue.ts and
// src/lib/offline-status-queue.ts) for when the tab was never closed at
// all.
//
// Deliberately NOT a precaching service worker: Next.js chunk filenames are
// content-hashed per build, so there is no fixed manifest to precache on
// install without this file being regenerated on every deploy. Runtime
// caching sidesteps that entirely — whatever the currently-deployed page
// actually requests is what gets cached, always in sync with the build.

const CACHE_NAME = "dhankipos-dashboard-shell-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only GET is safe/useful to cache. Every mutation (order creation,
  // status changes, payments, etc.) must always hit the network directly
  // and fail fast on the client — that's what lets each page's own
  // offline-queue logic catch the failure and queue the mutation; a
  // service worker silently swallowing or replaying a POST/PATCH would
  // risk duplicate or lost writes.
  if (request.method !== "GET") return;

  event.respondWith(
    (async () => {
      try {
        const networkResponse = await fetch(request);
        if (networkResponse.ok && new URL(request.url).origin === self.location.origin) {
          const cache = await caches.open(CACHE_NAME);
          cache.put(request, networkResponse.clone());
        }
        return networkResponse;
      } catch (err) {
        const cached = await caches.match(request);
        if (cached) return cached;
        throw err;
      }
    })(),
  );
});
