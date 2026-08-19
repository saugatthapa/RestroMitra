// Phase 11b (POS) / Phase 22 (offline mode) / Phase 22b (offline navigation fix)
// — dashboard shell service worker.
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
// Deliberately NOT a *static* precaching service worker: Next.js chunk
// filenames are content-hashed per build, so there is no fixed manifest to
// hardcode. Phase 22b's warming (below) still stays in sync with the
// current build — it discovers the exact asset/data URLs a live page
// currently needs by reading its own real response, not from a hardcoded
// list.
//
// --- Phase 22b: why v1 failed to let users even OPEN POS/Orders/KDS ---
//
// Reproduced "I can't even open the page while offline" with a real
// offline Playwright run (a full network block, not just a reload of an
// already-open tab) and found three compounding bugs:
//
// 1. Next.js App Router client-side navigation (clicking a sidebar <Link>)
//    doesn't request the plain page URL — it fetches a React Server
//    Component payload from the SAME pathname plus a `?_rsc=<token>` query
//    param that Next changes on essentially every navigation
//    (NEXT_RSC_UNION_QUERY in next/dist/client/components/app-router-headers.js).
//    v1 cached the exact request URL, `_rsc` included, so a later
//    navigation to a page visited earlier this session almost never hit
//    the cache anyway — the token differs. That failed fetch then makes
//    Next's own client runtime fall back to a full browser navigation (a
//    real top-level GET, no `_rsc`) — which only works if that exact plain
//    URL happens to already be cached.
// 2. A page only becomes "controlled" by this service worker — meaning its
//    own fetch()/script requests are even eligible to be intercepted — once
//    it's loaded via a fresh top-level navigation to a URL already inside
//    the registered scope, made *after* the worker is active. A tab that
//    logged in at /login (outside "/dashboard/" scope, and before this
//    worker existed) and then only ever moved around via client-side
//    <Link> navigation stays uncontrolled for its entire lifetime — none of
//    its RSC fetches, JS chunk loads, or API calls ever reach this worker
//    at all, no matter how long it's open. That's not a bug we can patch
//    around client-side; it's how the platform is specified. The one thing
//    that IS always freshly matched against an active worker's scope is a
//    genuine top-level navigation — which is exactly what Next's
//    browser-navigation fallback from (1) triggers. So that fallback is,
//    in the realistic case, the *only* path that can ever be served from
//    cache — which made bug 3 fatal:
// 3. Whether the plain URL, its JS/CSS chunks, and its data GETs were
//    cached came down to luck: only if the user happened to land on that
//    exact page via a hard/full reload at some point AND that reload was
//    itself already controlled. A user who only ever clicks the sidebar
//    never triggers any of that, so nothing is ever cached and the
//    fallback in (1) has nothing to serve — exactly reproducing "can't
//    even open the page."
//
// The fix, all in warmCriticalRoutes() below, run on every activation:
//   a. Proactively fetch the plain ("hard load") document for each
//      offline-critical route — this alone is what lets the browser-
//      navigation fallback in (1) succeed instead of failing outright.
//   b. Scan that document's own HTML/flight payload for every
//      /_next/static/... asset URL it actually references (including ones
//      not in a plain <script>/<link> tag — Next inlines lazily-loaded
//      chunk paths into the flight data as plain strings) and warm those
//      too, so the reloaded page's JS can actually boot and hydrate
//      instead of sitting frozen on its server-rendered "Loading…" state.
//   c. Extract the tenant's slug the same way (it's inlined as a
//      `"slug":"..."` prop in the same payload) and warm the read-only
//      data GETs (menu/categories/tables, orders) each page's first paint
//      depends on, so a freshly-hydrated-but-offline page has real (if
//      possibly stale) data to render instead of being stuck on "Loading
//      orders…" forever.
// Separately, RSC responses are now cached under a key with `_rsc`
// stripped, so any later RSC request for the same route hits regardless of
// token — this is what lets an offline sidebar click resolve as a smooth
// client-side transition instead of a full reload, for the (rarer, but
// real) case where the tab genuinely is SW-controlled.
//
// --- Phase 22c: 206 responses were silently breaking every cache write ---
//
// On at least one real deployment (Hostinger's Node.js hosting), the
// server/proxy in front of the app answers plain GETs — including ones
// this worker never attached a Range header to — with HTTP 206 instead of
// 200. The Cache API refuses to store ANY 206 response outright (it's a
// hard platform rule, not configurable), so every cache.put() call was
// throwing. Because that throw happened inside the fetch handler's own
// try/catch, it fell into the catch branch, found nothing usable cached
// (nothing had ever successfully been written), and rethrew — which is
// what actually produced the "can't open the page" failures in
// production, even though this exact code had already been verified
// working end-to-end locally (where the dev/prod server answers with a
// normal 200). Two changes fix this: cacheResponse() below normalizes a
// 206 into a 200 before storing (safe here specifically because this
// worker never requests a Range, so there's no legitimate partial content
// to lose — the body is the whole resource, just mislabeled by whatever's
// serving it), and every cache write is now wrapped so a failure there —
// 206, quota exceeded, anything — can never propagate and break the
// actual response the page receives. Caching was always meant to be
// best-effort; now it actually is.

const CACHE_NAME = "dhankipos-dashboard-shell-v2";
const RSC_QUERY_PARAM = "_rsc";
const RSC_HEADER = "rsc"; // Headers are case-insensitive; Next sends this on flight fetches.

// Routes whose plain ("hard load") document response we proactively warm so
// Next's browser-navigation fallback (see comment above) always has
// something to serve, independent of what the user actually visited this
// session. Kept short and deliberate — this is the offline-critical set,
// not a general precache list.
const WARM_PATHS = ["/dashboard", "/dashboard/pos", "/dashboard/orders", "/dashboard/kds"];

// Read-only data GETs these pages' own first-paint fetch depends on (see
// POS's `base(slug)` / OrdersBoard's `base(slug)` helpers) — warmed once we
// know the tenant slug (extracted from a warmed page's own payload) so a
// freshly-hydrated offline reload has real data instead of an infinite
// "Loading…" state. Deliberately short: only what these 3 offline-critical
// pages read on mount, not a general API precache.
const WARM_DATA_SUFFIXES = ["/categories", "/menu-items", "/tables", "/orders", "/header-status"];

const STATIC_ASSET_RE = /\/_next\/static\/[A-Za-z0-9_\-./%]+\.(?:js|css)/g;
// Next inlines RSC flight data as a JS string literal (its own quotes
// backslash-escaped), so the byte sequence is \"slug\":\"...\" rather than
// a bare "slug":"..." — match with an optional backslash before each quote
// so this keeps working whichever form a given response uses.
const SLUG_RE = /\\?"slug\\?":\\?"([A-Za-z0-9_-]+)\\?"/;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
      await self.clients.claim();
      await warmCriticalRoutes();
    })(),
  );
});

async function warmCriticalRoutes() {
  const cache = await caches.open(CACHE_NAME);
  const assetUrls = new Set();
  let slug = null;

  await Promise.all(
    WARM_PATHS.map(async (path) => {
      try {
        // A plain fetch from the service worker itself carries no `rsc`
        // header and no `_rsc` query, so this always requests the full
        // HTML document shape — exactly what a browser-navigation
        // fallback needs. `cache: "no-store"` skips the HTTP cache so a
        // fresh deploy's markup gets warmed, not a stale disk-cached copy.
        const response = await fetch(path, { cache: "no-store" });
        if (!response.ok) return;
        const body = await response.text();
        await cacheResponse(cache, docCacheKey(path), new Response(body, response));

        for (const match of body.matchAll(STATIC_ASSET_RE)) assetUrls.add(match[0]);
        if (!slug) {
          const slugMatch = body.match(SLUG_RE);
          if (slugMatch) slug = slugMatch[1];
        }
      } catch {
        // Offline (or logged out) at activation time — nothing to warm
        // yet; the next successful navigation to these routes will cache
        // them the normal way instead.
      }
    }),
  );

  await Promise.all(
    [...assetUrls].map(async (assetUrl) => {
      try {
        const response = await fetch(assetUrl, { cache: "no-store" });
        if (response.ok) await cacheResponse(cache, docCacheKey(assetUrl), response);
      } catch {
        // Same as above — best effort, next real load will fill it in.
      }
    }),
  );

  if (slug) {
    await Promise.all(
      WARM_DATA_SUFFIXES.map(async (suffix) => {
        const dataPath = `/api/restaurants/${slug}${suffix}`;
        try {
          const response = await fetch(dataPath, { cache: "no-store" });
          if (response.ok) await cacheResponse(cache, docCacheKey(dataPath), response);
        } catch {
          // Same as above.
        }
      }),
    );
  }
}

function docCacheKey(pathOrUrl) {
  const path = pathOrUrl.startsWith("http") ? new URL(pathOrUrl).pathname : pathOrUrl;
  return `${self.location.origin}${path}::doc`;
}

// The one place any response gets written to Cache Storage — see the
// Phase 22c comment above for why this exists. Never throws: a caching
// failure (206, quota exceeded, an opaque cross-origin response slipping
// through, whatever) is always swallowed here rather than allowed to
// break whatever real work the caller is doing.
async function cacheResponse(cache, key, response) {
  try {
    const toStore =
      response.status === 206
        ? new Response(response.body, { status: 200, statusText: "OK", headers: response.headers })
        : response;
    await cache.put(key, toStore);
  } catch {
    // Best-effort by design.
  }
}

// Builds the Cache Storage key we actually store/match under: same origin
// + pathname + search params with Next's `_rsc` cache-buster stripped,
// suffixed by response "shape" (rsc flight payload vs. full HTML document)
// since the two are not interchangeable — serving one in place of the
// other breaks the page.
function normalizedCacheKey(request) {
  const url = new URL(request.url);
  url.searchParams.delete(RSC_QUERY_PARAM);
  const isRSC = request.headers.get(RSC_HEADER) === "1";
  return `${url.origin}${url.pathname}${url.search}::${isRSC ? "rsc" : "doc"}`;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only GET is safe/useful to cache. Every mutation (order creation,
  // status changes, payments, etc.) must always hit the network directly
  // and fail fast on the client — that's what lets each page's own
  // offline-queue logic catch the failure and queue the mutation; a
  // service worker silently swallowing or replaying a POST/PATCH would
  // risk duplicate or lost writes.
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const cacheKey = normalizedCacheKey(request);

  event.respondWith(
    (async () => {
      try {
        const networkResponse = await fetch(request);
        if (networkResponse.ok) {
          const cache = await caches.open(CACHE_NAME);
          // Fire-and-forget: cacheResponse() never throws, so this can't
          // delay or fail the response we're about to return to the page.
          cacheResponse(cache, cacheKey, networkResponse.clone());
        }
        return networkResponse;
      } catch (err) {
        const cached = await caches.match(cacheKey);
        if (cached) return cached;
        throw err;
      }
    })(),
  );
});
