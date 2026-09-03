# SEO Content Calendar — RestroKendra

What this SEO pass built, what's deliberately deferred and why, and a realistic
backlog for the next 12 months. This is the honest continuation of
`SEO_KEYWORD_MAP.md` — nothing here is promised to rank; it's a prioritized list
of genuinely useful content still worth building.

## Indexing status (important — read this before judging "rankings")

As of the last check (September 3, 2026), **restrokendra.com is live and fully
functional, but has zero Google index footprint** — `site:restrokendra.com`
returns no results, and the brand name itself surfaces nothing relevant. All the
on-page SEO work in this file (metadata, structured data, comparison content)
makes pages worth ranking once they're crawled — it does not by itself cause
Google to crawl and index them. That step needs the site owner's own Google
account: Search Console verification + sitemap submission, at minimum. See
`SEO_INDEXING_SETUP.md` for the exact steps.

Once indexed, ranking above established competitors (RestroHub, RestroX,
Restronp, Recaho, Hamro SAN — all of which already rank for "nepal restaurant
software" per a live search checked this pass) takes real time: weeks to months,
not days, and depends on factors beyond on-page content — domain age, backlinks,
and real usage signals none of which a content pass can manufacture. Nothing in
this document should be read as a promise of a ranking position or a timeline.

## What shipped

**Wave 1:**
- Technical foundation: `src/lib/seo/` metadata/JSON-LD utilities, `sitemap.ts`,
  `robots.ts`, canonical URLs, homepage + `/site/[slug]` structured data.
- 1 pillar page: `/restaurant-pos-nepal`
- 3 feature pages: `/features/qr-ordering`, `/features/kds`, `/features/inventory`
- 2 comparison pages: `/compare/restrokendra-vs-restrohub`, `/compare/restrokendra-vs-restrox`
- 2 alternatives pages: `/alternatives/restrohub`, `/alternatives/restrox`

**Wave 2** (triggered by the user's own "nepal restaurant software" search, which
surfaced three competitors not previously researched):
- Google Analytics (GA4) installed sitewide via `next/script` in the root layout
  (see `src/lib/seo/analytics.ts`) — only loads when a measurement ID resolves,
  which it deliberately does not in local development.
- 3 more comparison pages: `/compare/restrokendra-vs-restronp`,
  `/compare/restrokendra-vs-recaho`, `/compare/restrokendra-vs-hamrosan`
- 3 more alternatives pages: `/alternatives/restronp`, `/alternatives/recaho`,
  `/alternatives/hamrosan`
- Meromenu was investigated but explicitly NOT built — see
  "Explicitly deferred" below.

All 14 content pages share one internal-linking web (see the bottom of
`SEO_KEYWORD_MAP.md`) so nothing shipped is an orphan page.

## Explicitly deferred this pass (with reasons)

| Item | Why deferred |
|---|---|
| Meromenu comparison/alternatives pages | meromenu.com is a fully client-rendered app shell — WebFetch gets back only a "Loading..." skeleton, no real content, from every page tried (home, pricing, FAQ, about). No pricing is published anywhere, including third-party listings (the one SoftwareSuggest listing found explicitly flags itself as incomplete). Writing comparison content here would mean guessing — not acceptable. Revisit if their site becomes fetchable or a real pricing page turns up. |
| NRestro comparison/alternatives pages | Not yet researched — out of scope for both SEO waves so far. Needs the same sourced WebSearch/WebFetch research pass before writing — do not write comparison copy about NRestro from memory or assumption. |
| City/location pages (Itahari, Sunsari, etc.) | The master brief explicitly bans doorway pages (a template with the city name swapped in and no real local content). RestroKendra's own public copy says it's launching first in Itahari and Sunsari — a page claiming broader local presence than that would misrepresent the business. Worth building once there's real local content to say. |
| Trust/E-E-A-T content (testimonials, case studies, reviews) | The user explicitly chose to skip this for now (AskUserQuestion answer this pass). None of it may be fabricated — build only once real customer testimonials/case studies exist with permission to publish them. |
| Admin-facing SEO controls / CMS | The master brief marks this optional and says to prefer the simplest architecture that works. With ~10 content pages total, hand-maintained files are simpler and safer than building a CMS — revisit only if the content volume grows enough to justify it. |
| A dedicated `/pricing` URL separate from the homepage `#pricing` anchor | The anchor already gets its own sitemap-eligible section; a standalone page is only worth it if analytics later show search traffic wants to land directly on pricing without the rest of the homepage. |

## Priority 1 — Next (remaining feature pages)

RestroKendra has real functionality with no dedicated SEO landing page yet. Same
template as the 3 feature pages already built (see `src/app/features/qr-ordering`
for the pattern): how it works, why it matters, links to the pillar page and
sibling features, honest copy grounded in what the product actually does.

1. `/features/billing` — split payments, paisa-accurate pricing
2. `/features/staff-attendance` — self-service clock-in/out, selfie verification, role permissions
3. `/features/payroll` — payroll tied to real attendance records
4. `/features/loyalty` — Bronze–Platinum tier program
5. `/features/reports` — revenue/expense trends, top-selling items, peak hours
6. `/features/ai-assistant` — plain-language Q&A over a restaurant's own data
7. `/features/multi-branch` — running more than one location from one login
8. `/features/website-builder` — the free public restaurant website (already live at `/site/[slug]`, needs its own explainer page)
9. `/features/reservations` — booking book with a status flow
10. `/features/account-books` — day/month/year cash book

Each of these is a real, already-shipped capability — writing them is expanding
coverage of what's true, not inventing content to fill a template.

## Priority 2 — Business-type pages

Genuinely different content per type (see Cluster 3 in the keyword map for why
these can't just be the pillar page with a word swapped in):

1. `/for/cafes`
2. `/for/cloud-kitchens`
3. `/for/bakeries`
4. `/for/bars`
5. `/for/fine-dining`

## Priority 3 — Blog / informational content

Starts once the feature-page backlog above is mostly cleared, since those pages
are closer to a ready-to-buy searcher. Suggested first 6 posts (see Cluster 5 in
the keyword map):

1. "How to calculate your real food cost (with recipe costing)"
2. "VAT and service charge on a Nepali restaurant bill, explained" — **verify current VAT rules at time of writing; don't publish stale regulatory content**
3. "How to reduce restaurant food wastage — a practical checklist"
4. "How to set up a QR code menu for your restaurant"
5. "Paper tickets vs. a kitchen display system: what actually changes"
6. "A restaurant owner's guide to staff scheduling in Nepal"

## Priority 4 — Competitor research follow-through

1. Research NRestro (WebSearch/WebFetch, same sourced approach as the other 5) and build its `/compare` + `/alternatives` pair once real figures are gathered.
2. Periodically retry Meromenu — their site may become fetchable, or a pricing page may eventually be published. Only build the comparison once real data can be sourced.
3. Re-verify all 5 built competitors' figures on a periodic basis (quarterly is reasonable) — `competitors.ts`'s `LAST_REVIEWED` date and the in-page "Last reviewed" stamps exist specifically so a stale re-check is visible, not silent.

## Priority 5 — Trust content (once real assets exist)

Only after real, permissioned material exists — never fabricated:

1. First real customer testimonials, with explicit permission to publish
2. A first real case study, once a restaurant has meaningful usage history
3. `aggregateRating`/`review` JSON-LD — only once real reviews exist; the JSON-LD builders in `src/lib/seo/json-ld.ts` deliberately omit these today

## Working agreement

Every future page in this calendar should follow the same standard the pages in
this pass did: real product facts, sourced competitor data with a visible
"Last reviewed" date, honest "which one may suit you" framing rather than a
one-sided pitch, and no invented numbers, ratings, or claims. If a page can't be
written to that standard yet (missing data, no real customers), it stays on this
list rather than getting shipped early.
