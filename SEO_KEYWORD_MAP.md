# SEO Keyword Map — RestroKendra

Keyword clusters for the Nepal restaurant-POS market, mapped to a target URL, page
type, and searcher intent. This is the working map behind what was built in this
SEO pass (see `SEO_CONTENT_CALENDAR.md` for what's still open) — every cluster
below is real search intent for this product category, not a padded list.

Search-volume figures aren't included: no keyword-volume tool was used this pass
(see SEO_AUDIT.md), so any number here would be a guess dressed up as data. Priority
is ranked by commercial intent and how directly it matches what RestroKendra
actually does, not by an unverified volume estimate.

## Legend

- **Intent**: Navigational (looking for a specific brand) · Commercial (comparing
  options, ready to evaluate) · Informational (researching the category) · Transactional (ready to sign up)
- **Status**: Built (this pass) · Planned (see content calendar) · Deferred (with reason)

## Cluster 1 — Core product / category (commercial + informational)

| Keyword | Target URL | Page type | Intent | Title concept | H1 concept | Status |
|---|---|---|---|---|---|---|
| restaurant pos nepal | `/restaurant-pos-nepal` | Pillar | Commercial | Restaurant POS Software in Nepal — What to Look For & How It Works | Restaurant POS software in Nepal: what it does, and what to check before buying | Built |
| restaurant pos software nepal | `/restaurant-pos-nepal` | Pillar | Commercial | (same as above) | (same as above) | Built |
| restaurant management software nepal | `/restaurant-pos-nepal` | Pillar | Commercial | (same as above) | (same as above) | Built |
| nepal restaurant software | `/restaurant-pos-nepal` | Pillar | Commercial | (same as above) | (same as above) | Built — this is the exact query the user searched that surfaced Restronp, RestroX, Meromenu, RestroHub, Recaho, and Hamro SAN in Google's results (see SEO_CONTENT_CALENDAR.md "Indexing status" note — the page targets this query, but the domain isn't indexed by Google yet as of the last check). |
| pos system for restaurant nepal | `/restaurant-pos-nepal` | Pillar | Commercial | (same as above) | (same as above) | Built |
| best restaurant pos nepal | `/restaurant-pos-nepal` + `/compare/*` | Pillar → Comparison | Commercial | (pillar) plus the two /compare pages | (same) | Built (honest positioning, no "#1" claim — see SEO safety rules) |
| qr code ordering system restaurant nepal | `/features/qr-ordering` | Feature | Commercial | QR Table Ordering for Restaurants — RestroKendra | QR table ordering | Built |
| kitchen display system nepal | `/features/kds` | Feature | Commercial | Kitchen Display System (KDS) for Restaurants — RestroKendra | Kitchen display (KDS) | Built |
| restaurant inventory management software nepal | `/features/inventory` | Feature | Commercial | Restaurant Inventory & Recipe Costing Software — RestroKendra | Inventory & recipe costing | Built |
| restaurant billing software nepal | `/restaurant-pos-nepal` (until a dedicated page exists) | Pillar | Commercial | — | — | Planned: dedicated `/features/billing` page (see calendar) |
| restaurant staff attendance software nepal | none yet | Feature | Commercial | — | — | Planned: `/features/staff-attendance` (see calendar) |
| restaurant payroll software nepal | none yet | Feature | Commercial | — | — | Planned: `/features/payroll` (see calendar) |
| restaurant loyalty program software | none yet | Feature | Commercial | — | — | Planned: `/features/loyalty` (see calendar) |

## Cluster 2 — Competitor-adjacent (commercial, high intent)

Built per the master brief's explicit strategy: never target a competitor's brand
name directly on the homepage or in ads; instead build genuinely useful, honest
`/compare` and `/alternatives` pages that a searcher who already knows the
competitor's name would find useful and fair.

| Keyword | Target URL | Page type | Intent | Status |
|---|---|---|---|---|
| restrohub vs restrokendra | `/compare/restrokendra-vs-restrohub` | Comparison | Commercial | Built |
| restrokendra vs restrohub | `/compare/restrokendra-vs-restrohub` | Comparison | Commercial | Built |
| restrohub alternative | `/alternatives/restrohub` | Alternatives | Commercial | Built |
| restrohub pricing | `/compare/restrokendra-vs-restrohub` (has sourced pricing) | Comparison | Commercial | Built |
| restrox vs restrokendra | `/compare/restrokendra-vs-restrox` | Comparison | Commercial | Built |
| restrokendra vs restrox | `/compare/restrokendra-vs-restrox` | Comparison | Commercial | Built |
| restrox alternative | `/alternatives/restrox` | Alternatives | Commercial | Built |
| restrox pricing | `/compare/restrokendra-vs-restrox` (has sourced pricing + monthly-equivalent) | Comparison | Commercial | Built |
| restronp vs restrokendra | `/compare/restrokendra-vs-restronp` | Comparison | Commercial | Built (SEO wave 2) |
| restronp alternative | `/alternatives/restronp` | Alternatives | Commercial | Built (SEO wave 2) |
| recaho vs restrokendra | `/compare/restrokendra-vs-recaho` | Comparison | Commercial | Built (SEO wave 2) |
| recaho alternative | `/alternatives/recaho` | Alternatives | Commercial | Built (SEO wave 2) |
| hamro san vs restrokendra | `/compare/restrokendra-vs-hamrosan` | Comparison | Commercial | Built (SEO wave 2) |
| hamro san alternative | `/alternatives/hamrosan` | Alternatives | Commercial | Built (SEO wave 2) |
| meromenu vs restrokendra | none | Comparison | Commercial | **Deferred** — meromenu.com is a fully client-rendered app shell that returns no readable content to WebFetch, and no pricing is published anywhere (their own site or any third-party listing checked). Writing a comparison from that would mean guessing at their features/pricing — not acceptable. Revisit only if their site becomes fetchable or a primary-source pricing page turns up. |
| nrestro vs restrokendra | `/compare/restrokendra-vs-nrestro` | Comparison | Commercial | **Deferred** — not yet researched (out of scope for both SEO waves so far). Needs the same WebSearch/WebFetch sourcing pass before writing. |
| nrestro alternative | `/alternatives/nrestro` | Alternatives | Commercial | **Deferred**, same reason. |

## Cluster 3 — Business-type modifiers (informational → commercial)

Not built this pass — flagged here as a real, legitimate cluster (a cafe's needs
genuinely differ from a fine-dining kitchen's) rather than thin variations of the
same page with a word swapped in.

| Keyword | Planned URL | Notes |
|---|---|---|
| pos system for cafe nepal | `/for/cafes` | Needs real content: what a cafe actually needs differently (fast small-ticket billing, no table service in many cases) — not the pillar page with "cafe" substituted in. |
| pos system for cloud kitchen nepal | `/for/cloud-kitchens` | Cloud kitchens don't need QR table ordering or floor plans at all — this page has to be honest about which modules apply. |
| bakery billing software nepal | `/for/bakeries` | |
| bar pos system nepal | `/for/bars` | |
| fine dining restaurant software nepal | `/for/fine-dining` | Reservations + floor plan + course-timing matter more here than fast QR turnover. |

## Cluster 4 — Location (deliberately NOT built as doorway pages)

The master brief explicitly bans generating a `/pos-in-<city>` page per city with
swapped place-names and no real local content — that's a doorway-page pattern
search engines actively penalize, and it would be dishonest: RestroKendra is
publicly described (see the homepage and footer) as launching first in Itahari and
Sunsari, not already operating nationwide.

| Keyword | Status | Reasoning |
|---|---|---|
| restaurant pos itahari | Deferred | Legitimate once there's real local content to say (actual local customers, a local phone number, testimonials) — not before. |
| restaurant pos sunsari | Deferred | Same reasoning. |
| restaurant pos kathmandu / pokhara / biratnagar / etc. | Not planned | Would misrepresent current service area. Revisit only once true. |

## Cluster 5 — Informational / blog (top-of-funnel, longer-term)

Not built this pass (see content calendar for prioritization). Genuine questions a
Nepali restaurant owner searches before they're ready to compare vendors by name.

| Keyword | Planned content | Notes |
|---|---|---|
| how to calculate restaurant food cost nepal | Blog: "How to calculate your real food cost (with recipe costing)" | Links to `/features/inventory`. |
| vat on restaurant bill nepal | Blog: "VAT and service charge on a Nepali restaurant bill, explained" | Real regulatory content — needs care to stay accurate and current; do not publish without verifying against current VAT rules at time of writing. |
| how to reduce restaurant food wastage | Blog | Links to `/features/inventory`. |
| restaurant staff scheduling tips | Blog | Links to a future `/features/staff-attendance`. |
| how to set up qr code menu for restaurant | Blog: practical how-to | Links to `/features/qr-ordering`; genuinely useful even to a reader who doesn't buy RestroKendra. |

## Cluster 6 — Brand (navigational)

| Keyword | Target | Notes |
|---|---|---|
| restrokendra | `/` | Homepage already covers this; `organizationJsonLd()`/`websiteJsonLd()` added this pass help establish the entity. |
| restrokendra pricing | `/#pricing` (anchor) | Covered; a dedicated `/pricing` page is a future option if the anchor section ever needs its own indexable URL (see calendar). |
| restrokendra login | `/login` (NOINDEX by design) | Intentionally not optimized — see SEO_ROUTE_POLICY.md. |

---

Internal linking is deliberately dense within a cluster: the pillar page links to
every feature page and both `/compare` pages; each feature page links back to the
pillar and to the other two features; each `/compare` page links to its sibling
`/alternatives` page and back to the pillar. No orphaned pages were created this
pass — every new URL has at least one real, in-content inbound link, not just a
sitemap entry.
