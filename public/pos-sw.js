// Phase 11b — Offline POS service worker.
//
// Registered ONLY for the /dashboard/pos page (see
// src/app/dashboard/pos/OfflineServiceWorker.tsx, scope: "/dashboard/pos/"),
// so it never touches any other page's network behavior — a stale cached
// response on, say, a subscription-gated redirect would be a real bug, not
// a convenience. Within its scope it's a plain network-falling-back-to-cache
// strategy: every successful same-origin GET response is cached, and if a
// later request for the same URL fails outright (no connectivity), the
// cached copy is served instead. This is what keeps the POS page — its
// HTML/JS/CSS bundle, and its own menu/tables API calls — usable across a
// hard reload while offline, on top of the localStorage menu snapshot and
// IndexedDB order queue the page itself already keeps (see
// src/lib/offline-queue.ts) for when the tab was never closed at all.
//
// Deliberately NOT a precaching service worker: Next.js chunk filenames are
// content-hashed per build, so there is no fixed manifest to precache on
// install without this file being regenerated on every deploy. Runtime
// caching sidesteps that entirely — whatever the currently-deployed page
// actually requests is what gets cached, always in sync with the build.

const CACHE_NAME = "dhankipos-pos-shell-v1";

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

  // Only GET is safe/useful to cache. Order submission (POST) must always
  // hit the network directly and fail fast on the client — that's what lets
  // POSOrderBuilder's own offline-queue logic catch the failure and queue
  // the order; a service worker silently swallowing or replaying a POST
  // would risk duplicate/lost orders.
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
