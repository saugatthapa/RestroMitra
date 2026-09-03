# Getting RestroKendra Indexed by Google — Setup Steps

Everything in `SEO_AUDIT.md`, `SEO_KEYWORD_MAP.md`, and the pages themselves makes
restrokendra.com's pages *worth* ranking. It does not make Google *crawl and index*
them — that's a separate step, and as of September 3, 2026, `site:restrokendra.com`
returns zero results: the domain has no Google index footprint at all yet. This
doc is the exact, step-by-step fix for that, and every step below needs your own
Google account — none of it can be done from this session.

Nothing here is a promise of a ranking position or a timeline. Getting indexed
typically takes days to a couple of weeks once submitted; ranking competitively
against established competitors after that takes longer and depends on factors
outside on-page content (domain age, backlinks, real usage).

## 1. Verify the site in Google Search Console

Search Console is how you tell Google the site exists, submit a sitemap, and
later see what's actually ranking and what isn't.

1. Go to [search.google.com/search-console](https://search.google.com/search-console) and sign in with the Google account you want to own this (your business account, not a personal one you might lose access to).
2. Click **Add property**.
3. You'll be offered two property types — pick **Domain** if you can (it covers `restrokendra.com`, `www.restrokendra.com`, and `http`/`https` all at once):
   - **Domain property**: Google gives you a TXT record to add at your domain registrar (wherever you bought `restrokendra.com`) — DNS → add a new **TXT** record with the exact host/value Google shows you, save, then click **Verify** in Search Console. DNS changes can take a few minutes to a few hours to take effect; if verification fails immediately, wait 15–30 minutes and retry.
   - **URL prefix property** (use this if you can't access DNS, or want a faster path): pick `https://restrokendra.com`, choose the **HTML tag** method, and send me the meta tag Google gives you (looks like `<meta name="google-site-verification" content="..." />`) — I'll add it to `src/app/layout.tsx`'s metadata (there's already a `verification` field Next.js supports for exactly this) and you redeploy. Or use the **HTML file** method: download the file Google gives you and I'll add it to `public/` so it's served at the exact path Google expects.
4. Once verified, you'll land on the property's dashboard.

## 2. Submit the sitemap

1. In Search Console, open **Sitemaps** in the left sidebar.
2. Enter `sitemap.xml` (the field already assumes your domain) and click **Submit**.
3. This tells Google every indexable URL on the site — currently 14 SEO content pages plus the homepage, `/privacy`, `/terms`, and any published `/site/[slug]` restaurant websites, generated live by `src/app/sitemap.ts`. Google will crawl these on its own schedule after this.

## 3. Request indexing for the pages that matter most (optional, speeds things up)

Sitemap submission alone works, but you can nudge specific URLs faster:

1. In Search Console, use the **URL Inspection** tool (top search bar) and paste a full URL, e.g. `https://restrokendra.com/`.
2. If it says "URL is not on Google," click **Request indexing**. Google will crawl that specific page sooner (usually within a day or two) rather than waiting for its normal crawl schedule.
3. Worth doing this for: the homepage, `/restaurant-pos-nepal`, and your `/compare/*` pages — the highest-intent pages.
4. There's a daily quota on this per property, so don't try to force all 14+ pages through it in one sitting — sitemap submission covers the rest over time regardless.

## 4. Set up a Google Business Profile

This is separate from Search Console and matters for a different reason: the
search result you shared had a "More places" / Maps-style result at the top,
which comes from Google Business Profile listings, not from web indexing. A
software product without a single physical storefront doesn't always fit this
neatly, but if RestroKendra has any real office/support address in Itahari or
Sunsari, a verified Business Profile is worth having:

1. Go to [google.com/business](https://www.google.com/business/) and sign in.
2. Add the business with a real, verifiable address and phone number — Google will mail a postcard with a verification code to that address, or offer phone/email verification depending on the category.
3. **Do not** invent an address or use a residential address you can't actually receive mail at — Google actively suspends listings that fail this, and it would also violate the "never fabricate" rule this whole SEO effort has followed.
4. If there's no single physical office to verify, skip this step for now — it isn't required for the site itself to get indexed, only for a Maps-style listing.

## 5. (Optional, low effort) Submit to Bing Webmaster Tools too

Bing has meaningfully less traffic than Google in most markets, but setup takes
five minutes once you've done Search Console:

1. [bing.com/webmasters](https://www.bing.com/webmasters) → sign in → **Import from Google Search Console** (it can pull your verified property directly if you allow access) — this verifies AND submits the sitemap in one step.

## 6. Google Analytics is already installed — link it to Search Console

The GA4 tag (measurement ID `G-12QPHRRPNV`) is now live sitewide (see
`src/lib/seo/analytics.ts` and the root layout) — it starts recording visits as
soon as this build is deployed to production. It's a separate tool from Search
Console (GA measures traffic/behavior once someone's on the site; Search Console
measures what Google indexes and how the site performs *in search results*
before a click even happens), but they're commonly linked so Search Console data
shows up inside GA reports too:

1. In Google Analytics (analytics.google.com), go to **Admin** → the property → **Search Console Links**.
2. Click **Link**, pick the `restrokendra.com` Search Console property you just verified, and confirm.

## What I can't do from here

Every step above requires a Google account you own — sign-in, domain DNS access,
or a physical mailing address for verification. I can prepare anything
code-side (the HTML-tag or HTML-file verification method, for instance) the
moment you have the value Google gives you to add — just paste it here.

## Realistic expectations

- Verification + sitemap submission: minutes, once you have DNS or file access.
- First pages showing up in Google's index: typically a few days to two weeks after submission.
- Ranking competitively for "nepal restaurant software" and similar terms against RestroHub, RestroX, Restronp, Recaho, and Hamro SAN — all of which are already indexed and have been live for a while: this takes longer, and depends on things beyond what's in this repository (backlinks, real customer usage signals, domain age, how often content gets updated). Nothing in the SEO work delivered so far promises a specific ranking or timeline — see `SEO_CONTENT_CALENDAR.md`'s "Indexing status" section for the same caveat in context.
