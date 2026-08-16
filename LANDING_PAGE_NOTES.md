# Landing page redesign

A full rebuild of the public marketing page (`/`), done ahead of Phase 10 at the
user's request, with two goals: look and feel more advanced than the category's
existing Nepal-market competitors, and stay fast — this is the page every prospect
sees before ever logging in, so its load time matters more than any authenticated
page in the app.

## Competitive research

Fetched and analyzed restrohub.com.np (the standing competitive benchmark for this
project) before designing anything. Findings: a fabricated-sounding "500+
restaurants, 4.9/5 from 30+ reviews" trust block, a 24-item plain bulleted feature
list with no icons or cards, a comparison table naming unlabeled "System A"/"System
B" competitors, indigo (#6366f1) branding, and no visible motion/animation in the
markup — it's a content-dense, static page. That set a clear bar: DhankiPOS's
landing page uses real product-matched feature cards with icons, an actual
interaction layer (scroll reveals, hover states, an accordion, a floating product
mockup), and does NOT fabricate customer counts or ratings the product doesn't
have yet — the differentiators section only claims things that are true today
(30-day trial, no credit card, built for Eastern Nepal, one connected system).

## What changed

- **`src/app/page.tsx`** — full rewrite. Sticky blurred header with a mobile
  hamburger menu, a hero with an animated gradient-blob backdrop and a floating
  "product mockup" (live sales card with a sparkline, a kitchen ticket card, a
  loyalty card — all CSS-animated, no real screenshot dependency), a 9-card feature
  grid matching every module actually shipped through Phase 9 (QR ordering, POS,
  KDS, inventory, staff, customers/loyalty, expenses, reservations, reports), a
  3-step "how it works" flow with a connecting line, a comparison table (DhankiPOS
  vs. paper/spreadsheets vs. generic POS software — deliberately not naming a
  specific competitor, since verifying exact current feature parity/pricing against
  a live competitor site isn't something this project can stand behind as fact), a
  gradient CTA banner, an FAQ accordion, and a footer.
- **`src/components/landing/Reveal.tsx`** (new, client) — a scroll-triggered
  fade/slide-in wrapper built on `IntersectionObserver`, not an animation library.
  Reveals once per element and disconnects its observer (a marketing page shouldn't
  replay its own entrance animation every time someone scrolls back up).
- **`src/components/landing/FaqAccordion.tsx`** (new, client) — an accessible
  accordion (`aria-expanded`, keyboard-operable button triggers) animated via a CSS
  grid-template-rows transition rather than measuring heights in JS.
- **`src/components/landing/MobileNav.tsx`** (new, client) — the hamburger menu for
  the sub-`sm` breakpoint.
- **`src/app/globals.css`** — added the animation layer: `.reveal`/`.reveal-visible`
  (paired with the Reveal component), ambient background-blob drift, floating-card
  bob, a one-shot hero entrance, a diagonal shine sweep on the primary CTA's hover,
  and a pulsing status dot — all `transform`/`opacity`-only keyframes so they stay
  on the GPU compositor and never trigger layout. A single
  `@media (prefers-reduced-motion: reduce)` block turns every animation off and
  reveals content immediately for anyone who's asked their OS for less motion.

## Performance decisions (the "fast, low latency" part of the ask)

- **No animation library.** Every motion effect here is plain CSS keyframes/
  transitions plus one ~30-line `IntersectionObserver` hook — framer-motion or
  similar would have added real First Load JS for a page whose main job is to load
  instantly on a mid-range phone over Nepali mobile data.
- **No icon library.** All 9 feature icons, the logo mark, arrows, and checkmarks
  are hand-written inline SVGs — same reasoning, and consistent with this project's
  existing pattern of avoiding a charting-library dependency for Phase 9's chart.
- **No custom webfont.** `next/font/google` (Plus Jakarta Sans) was tried first,
  but this sandbox has no outbound access to `fonts.googleapis.com`, which would
  have broken `next build` in any network-restricted environment (including some
  CI runners) — and more importantly, a webfont is bytes and a font-swap the
  existing system-font stack in `globals.css` doesn't pay for at all. Dropped in
  favor of the system stack already in place; the page still reads as intentional
  at the font-weights/tracking used.
- **The route is statically prerendered.** `next build` marks `/` as `○ (Static)`
  — the whole page is generated once at build time and can be served from a CDN
  edge with zero server round-trip, not rendered per-request like the
  authenticated dashboard routes.
- Verified no horizontal overflow at 375px/390px/1440px viewports (the animated
  background blobs are a common source of accidental horizontal scroll if not
  contained — the root wrapper carries `overflow-x-clip` specifically to guard
  against this).

## Verification

- `tsc --noEmit` and `eslint` clean on all new/changed files.
- `next build` succeeds; `/` prerenders as static.
- Full Vitest suite still green (260/260 — a marketing-page redesign touches no
  business logic, so no new tests were needed here).
- Playwright screenshots (`scripts/screenshot-landing.mjs`) at desktop (1440px),
  tablet (834px), and mobile (390px, touch-enabled) viewports, including the hero,
  scroll-revealed feature/compare/FAQ sections (captured by scrolling first — a
  `fullPage` screenshot alone doesn't trigger `IntersectionObserver`, since Chrome's
  full-page capture doesn't actually scroll through the document), the mobile
  hamburger menu open, and an FAQ item expanded — all visually reviewed.

## Known gaps / deliberately deferred

- **No real product screenshots in the hero.** The floating mockup cards are
  hand-drawn to match the real dashboard's visual language (same orange palette,
  same card style) rather than embedding an actual screenshot, so they never go
  stale as the real UI evolves — an actual screenshot carousel is a reasonable
  future upgrade once the UI is more visually final.
- **No Nepali-language copy.** The rest of the app is English-only (see the
  standing "no i18n yet" gap noted since Phase 1); the landing page intentionally
  does not claim bilingual support it doesn't have.
- **No blog/case-studies/company pages.** The footer's nav is scoped to the
  single-page sections that exist; those are natural additions once there's real
  content for them.

## Next steps

Continuing on to **Phase 10 (SaaS plans/trials/subscriptions/platform admin)** per
the original roadmap, as requested in the same instruction that asked for this
landing page work.
