# SEO Route Policy — RestroKendra

Every route in the app, classified. Enforced by two independent layers (belt + suspenders, since either one failing shouldn't leave a private route exposed):

1. **`src/app/robots.ts`** — tells well-behaved crawlers not to request `PRIVATE` paths at all.
2. **Per-page `robots: { index: false }` in `generateMetadata`/`metadata`** — for `NOINDEX` routes, which crawlers legitimately *can* request (they're real, reachable, sometimes-linked pages) but must never show in search results. `robots.txt` alone is not enough here: blocking a URL in `robots.txt` stops crawling but a URL that's already linked somewhere can still appear in search results as a bare link with no snippet — the actual "keep this out of Google" mechanism is the page's own `noindex` meta tag.

Legend: **INDEX** = should rank, actively optimized · **NOINDEX** = real, reachable page, explicitly excluded from search results · **PRIVATE** = blocked in `robots.txt`, never crawled · **DYNAMIC PUBLIC** = conditionally indexable, DB-driven · **REDIRECT** = not a content route.

## INDEX (public marketing — should rank)

| Route | Status | Notes |
|---|---|---|
| `/` | INDEX | Homepage, primary keyword target. Metadata + JSON-LD added this pass. |
| `/privacy` | INDEX | Already had unique metadata; canonical added. |
| `/terms` | INDEX | Already had unique metadata; canonical added. |
| `/restaurant-pos-nepal` | INDEX | New pillar page (this pass). |
| `/features/qr-ordering` | INDEX | New feature page (this pass). |
| `/features/kds` | INDEX | New feature page (this pass). |
| `/features/inventory` | INDEX | New feature page (this pass). |
| `/compare/restrokendra-vs-restrohub` | INDEX | New, factual, sourced (this pass). |
| `/compare/restrokendra-vs-restrox` | INDEX | New, factual, sourced (this pass). |
| `/alternatives/restrohub` | INDEX | New, factual, sourced (this pass). |
| `/alternatives/restrox` | INDEX | New, factual, sourced (this pass). |

Everything else under `SEO_CONTENT_CALENDAR.md` (remaining feature pages, industry pages, blog) is **planned INDEX**, not yet built.

## DYNAMIC PUBLIC (conditionally indexable, DB-driven)

| Route | Status | Notes |
|---|---|---|
| `/site/[slug]` | DYNAMIC PUBLIC | Indexable only when `restaurantWebsites.isPublished = true` AND the restaurant `isActive`. An unpublished/inactive site returns `notFound()` today (correct — 404s are naturally excluded) but its `generateMetadata` fallback (`{ title: "Not found" }`) had no explicit `noindex`; added this pass so the interstitial content Next may still render before the 404 boundary resolves is never eligible for indexing. Included in `sitemap.ts` via a DB query for published sites only. |

## NOINDEX (real pages, must stay out of search results)

| Route | Reason |
|---|---|
| `/(auth)/login` | Auth utility page, no search value, and appearing in results invites credential-phishing lookalikes to rank alongside it. |
| `/(auth)/register` | Converts from the homepage CTA, not from search; a bare "Register" result with no context converts worse than the homepage itself. |
| `/(auth)/forgot-password` | Auth utility page. |
| `/(auth)/reset-password/[token]` | Contains a single-use secret token in the URL — must never be indexed or cached by a search engine. |
| `/order/[token]` | Per-table QR ordering page, token-gated. No search intent exists for a specific table's token, and indexing would leak table/restaurant pairings publicly. |
| `/print/kot/[orderId]` | Internal kitchen ticket. Contains order contents; no reason to be public. |
| `/print/payslip/[paymentId]` | Contains a staff member's name, pay, and payment method — real PII. Must never be indexed. |
| `/maintenance` | Interstitial system-state page, not real content. |
| `/suspended` | Interstitial system-state page, not real content. |

## PRIVATE (blocked in `robots.txt`)

| Route prefix | Count | Reason |
|---|---|---|
| `/dashboard/*` | 24 pages | Authenticated tenant app. Session-gated by middleware already; `robots.txt` disallow is defense-in-depth. |
| `/onboarding` | 1 | Authenticated, mid-signup-flow. |
| `/billing` | 1 | Authenticated, tenant-scoped billing management (distinct from the public `/pricing` content that should exist — see content calendar). |
| `/admin/*` | 13 pages | Platform-admin console. Should never be discoverable, let alone indexed. |
| `/api/*` | 204 route handlers | Not HTML, never indexable, but disallowing the whole prefix in `robots.txt` avoids crawler traffic/log noise hitting authenticated JSON endpoints for no reason. |

## Notes on things that look like they need a policy but don't

- **`/icon.png`, `/favicon.ico`, `/manifest.json`, `public/brand/*`**: static assets, not pages — no metadata/indexing concept applies; `robots.txt` explicitly does **not** block these (Phase 21's own warning against accidentally blocking assets required for rendering is respected — nothing under `/brand`, `/_next/static`, or the root-level icon files is disallowed).
- **Root layout's static `metadata` export**: still the correct fallback for any route that doesn't override it (e.g. `/maintenance`, `/suspended` inherit it) — since those are already `NOINDEX` via `robots.txt`/route logic, the shared title being generic there is harmless.
