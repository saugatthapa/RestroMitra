# SEO Audit — RestroKendra

Audited directly against the current repository at `/home/claude/dhankipos` (Next.js 15.5.24, App Router). This supersedes any prior/assumed audit — nothing here is carried over from an earlier brand (RestroMitra) without re-verification.

Production domain (per owner decision, 2026-09-03): **`https://restrokendra.com`**. No domain was previously configured anywhere in the repo — see "Domain & environment" below.

## 1. Architecture

- **Framework**: Next.js 15.5.24, App Router, TypeScript. 256 route files total: 52 `page.tsx` + 204 API `route.ts` handlers.
- **Rendering**: server components by default; `"use client"` only on interactive boards/forms. The homepage (`src/app/page.tsx`) is already async + `export const revalidate = 3600` (ISR), so its content is present in the initial server-rendered HTML — good for crawlability.
- **Multi-tenant**: every restaurant's data is scoped by `slug`/`restaurantId`; public-facing tenant surfaces are `/site/[slug]` (restaurant's own website) and `/order/[token]` (QR ordering menu, token-gated, intentionally not discoverable/indexable).
- **Auth boundary**: `src/middleware.ts` redirects `/dashboard/*` and `/onboarding/*` to `/login` when no session cookie is present. This is routing convenience only, not the indexing control — indexing is controlled separately via `robots.txt` (see Phase 21 below), since middleware doesn't stop a crawler from requesting the page and Next still needs those routes explicitly excluded.

## 2. Existing SEO surface (what's already there)

| Surface | State |
|---|---|
| Root metadata (`src/app/layout.tsx`) | Static `export const metadata` — good title/description already ("RestroKendra — The Restaurant Operating System for Nepal..."), but **no canonical, no OpenGraph, no Twitter card, no `metadataBase`**. Every page that doesn't override this inherits the exact same title/description (a duplicate-title risk for any page without its own metadata). |
| Homepage (`/`) | **No `export const metadata` or `generateMetadata` at all** — silently inherits the root layout's generic title. No OG, no canonical, no JSON-LD. |
| `/site/[slug]` (public restaurant website) | Already has `generateMetadata` pulling a per-tenant `seoTitle`/`seoDescription` from the DB (`resolveWebsiteContent`), plus a conditional OG image. **Good foundation** — closest thing to a working SEO pattern in the repo. Missing: canonical, Twitter card, JSON-LD (LocalBusiness/Restaurant), and a 404/`noindex` for unpublished sites returns a bare `{ title: "Not found" }` with no `robots: { index: false }`. |
| `/terms`, `/privacy` | Static `metadata` export, decent unique titles. No canonical/OG. |
| `/order/[token]` (QR menu) | No metadata at all (inherits root). Correct behavior would be explicit `noindex` — this is a token-gated per-table page with no reason to be indexed, and right now nothing stops a crawler that discovers a leaked/shared link from indexing it. |
| `/print/kot/[orderId]`, `/print/payslip/[paymentId]` | No metadata. Should be `noindex` (internal operational documents). |
| `/billing`, `/onboarding`, `/dashboard/*`, `/admin/*` | Authenticated app surfaces. No metadata, no `noindex` directive of their own — currently relying entirely on **not existing in a sitemap and not being linked from anywhere public**, i.e. security-through-obscurity, not an actual indexing control. |
| **`sitemap.ts`** | **Does not exist.** No `src/app/sitemap.ts`, no static `public/sitemap.xml`. |
| **`robots.ts` / `robots.txt`** | **Does not exist.** No `src/app/robots.ts`, no `public/robots.txt`. A crawler hitting `/robots.txt` today gets a 404, which most crawlers treat as "no restrictions" — i.e. `/dashboard`, `/admin`, `/api`, `/print`, `/order/[token]` are all currently crawlable in principle (mitigated only by having no inbound links and requiring a session for most of them). |
| **Canonical URLs** | None anywhere. No `metadataBase`, so any relative OG/canonical Next.js *would* generate has no base to resolve against. |
| **JSON-LD / structured data** | None anywhere in the repo (`grep -r "application/ld+json"` returns nothing). |
| **`manifest.json`** | Exists and is correct for its purpose (PWA install), not an SEO artifact. |
| Brand assets | `public/brand/icon-{128,256,512}.png`, `logo-horizontal.png` exist — usable for OG images / JSON-LD `logo`. No dedicated 1200×630 OG share image exists yet. |

## 3. Domain & environment

- No `NEXT_PUBLIC_SITE_URL`/`SITE_URL` anywhere in `.env.local`, `.env.example`, `package.json`, `README.md`, or deploy config.
- The repo **already has** a server-side `APP_URL` env var (`.env.local: APP_URL="http://localhost:3100"`, `.env.example: APP_URL="http://localhost:3000"`), used in 8 places for absolute-URL construction (password reset emails, table QR codes, payment gateway callback URLs, website QR codes). All SEO surfaces that need an absolute URL (`generateMetadata`, `sitemap.ts`, `robots.ts`) run **server-side only** in the App Router, so this repo does not need a second, parallel `NEXT_PUBLIC_SITE_URL` — reusing `APP_URL` avoids two "the app's URL" variables drifting apart. See `lib/seo/site.ts` (new).
- **Action taken**: `.env.example` documents `APP_URL=https://restrokendra.com` as the required production value. **Action required of the deploy owner**: set `APP_URL=https://restrokendra.com` in the actual production environment (Hostinger/Vercel env vars) — this repo cannot verify or set that from here.
- Deployment target per `README.md`: single-instance Hostinger Node.js app, with Vercel documented as a secondary/reference path.

## 4. Route classification (summary — full table in `SEO_ROUTE_POLICY.md`)

| Category | Routes | Count |
|---|---|---|
| **INDEX** (public marketing, should rank) | `/`, `/privacy`, `/terms`, and new SEO pages built this pass | small, growing |
| **DYNAMIC PUBLIC, conditionally indexable** | `/site/[slug]` (only when the tenant's website is published) | N/A (DB-driven) |
| **NOINDEX** (real pages, must not rank) | `/login`, `/register`, `/forgot-password`, `/reset-password/[token]`, `/order/[token]`, `/print/kot/[orderId]`, `/print/payslip/[paymentId]`, `/maintenance`, `/suspended` | 9 |
| **PRIVATE** (blocked in robots.txt, never should be crawled at all) | `/dashboard/*`, `/onboarding`, `/billing`, `/admin/*`, `/api/*` | ~230 |

## 5. Problems found (prioritized)

**Critical (fixed this pass):**
1. No `robots.txt` — private routes are technically crawlable today.
2. No `sitemap.xml` — nothing tells search engines what to index, including the one dynamic public surface (`/site/[slug]`) that should grow over time.
3. No canonical URLs anywhere — duplicate-content risk is structurally unmanaged (query strings, `www` vs bare domain, etc. are all unresolved).
4. Homepage has zero page-specific metadata — the single highest-traffic page on the whole site currently has the weakest metadata of any page in the repo.
5. No OpenGraph/Twitter card anywhere — links shared in WhatsApp/Facebook/Twitter (the primary sharing channels for a Nepal-market product) render with no title, no image, no description.
6. No JSON-LD — zero structured data means no rich-result eligibility (Organization, SoftwareApplication, FAQ, BreadcrumbList) at all.

**High (fixed this pass where in scope):**
7. `/order/[token]` and `/print/*` have no `robots: noindex` — should never appear in search results (customer PII risk on the print views: names, phone numbers, amounts).
8. No FAQ structured data despite the homepage already having a real, accurate FAQ section (`FAQ_ITEMS` in `page.tsx`) — free rich-result eligibility currently left on the table.
9. Landing page has zero internal links to any deeper SEO content, because no deeper SEO content exists yet (see Content Gap below) — the homepage's `NAV_LINKS`/`FEATURES` array is real product content but doesn't map to real URLs.

**Medium (documented, not all fixed this pass — see `SEO_CONTENT_CALENDAR.md`):**
10. No topical content beyond the single homepage — zero pillar pages, zero feature pages, zero blog/guide content, zero comparison pages. This is the largest gap by far; a single well-optimized homepage cannot rank for the ~80 keyword variants in scope (see `SEO_KEYWORD_MAP.md`).
11. `/site/[slug]` (the one growth surface that scales with the customer base) has no JSON-LD (`Restaurant`/`LocalBusiness` would be directly applicable and factual per-tenant) and no canonical.
12. No image alt-text audit was run against the ~40 hand-authored SVG icons on the landing page (decorative, not photographic — low priority; real photographic content doesn't exist yet since there are no real customer screenshots/case studies in the repo to begin with, matching the "skip trust content for now" decision).

**Not applicable / correctly absent:**
13. No blog/CMS infrastructure exists, and none should be force-fitted — Phase 58's own instruction ("do not add a CMS if the architecture doesn't need one") is followed: new SEO pages are plain App Router pages (matching the rest of the marketing site), not a database-backed content model, since volume doesn't yet justify one.
14. No location/city pages were built — per the "no doorway pages" rule and the fact that the product currently only serves Itahari & Sunsari (per the homepage's own honest copy), city pages for Kathmandu/Pokhara/etc. would have no genuine local content to contain and were correctly left out of this pass.

## 6. Performance (brief; full Core Web Vitals audit needs a live deploy, not this sandbox)

- Homepage already avoids `next/font/google` (system font stack) — zero webfont download cost, documented in `globals.css`'s own comment as a deliberate choice for Nepali mobile data conditions.
- Homepage hero mockup is hand-built markup (SVG icons + CSS), not a screenshot image — zero image weight for the highest-visibility above-the-fold content.
- No egregious client-heavy marketing components found; `MobileNav`, `Reveal`, `FaqAccordion`, `PricingCards` are small, scoped client islands, not full-page client components.
- Real Core Web Vitals (LCP/INP/CLS) require a production deploy to measure honestly — not fabricated here. Recommended next step: run PageSpeed Insights / Search Console's Core Web Vitals report once `restrokendra.com` is live.

## 7. What this pass implemented

See the final deliverable summary in chat for the complete list. In short: `lib/seo/` metadata utilities, `sitemap.ts`, `robots.ts`, homepage + key-page metadata/canonical/OG/Twitter, Organization + WebSite + SoftwareApplication + FAQPage JSON-LD (factual fields only, no fabricated ratings/reviews per the explicit brief), `noindex` on private-feeling public routes, two comparison pages and two alternatives pages (RestroHub, RestroX — built from real web research, sourced and dated), one pillar page (`/restaurant-pos-nepal`) and three feature pages, `SEO_KEYWORD_MAP.md`, `SEO_ROUTE_POLICY.md`, and `SEO_CONTENT_CALENDAR.md` for everything not yet built.

## 8. What this pass explicitly did NOT do, and why

- **No trust/E-E-A-T content** (About page, testimonials, case studies, social profile links, Organization `sameAs`) — per your explicit instruction this session, since none of that content is real yet and the brief prohibits fabricating any of it.
- **No blog articles were published** — a genuine 12-month content calendar of 40+ articles cannot be written to a real quality bar in one implementation pass without becoming exactly the "filler to hit a calendar" anti-pattern the brief itself warns against. `SEO_CONTENT_CALENDAR.md` prioritizes what to write next instead.
- **No city/location pages** — the product's own honest "launching in Itahari & Sunsari" positioning means most Nepali city pages would have no genuine local content yet; doorway pages were explicitly ruled out.
- **No `/reviews` page** — no real reviews exist to publish.
