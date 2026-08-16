# Phase 15 — Menu item photos (menu, POS, and QR ordering)

Scope: menu items previously showed name-only everywhere they appeared as a
card. Requested directly by the user: *"right now i see foods are only shown
in name but i want it to be shown in name and image both in card system."*

## Why this matters

A restaurant menu without photos is a much harder sell to customers — QR
ordering in particular lives or dies on whether the food looks appetizing
before anyone commits to an order. This phase makes item photos a first-class
part of the card everywhere an item is rendered: the admin menu manager, the
staff POS grid, and the customer-facing QR menu.

## What's done and verified

- **No new database column needed** — `menuItems.imageUrl` (nullable text)
  already existed in the schema from an earlier phase but was never wired
  into any UI or given real validation. This phase is entirely about
  actually using it correctly.
- **Client-side image upload, no new infrastructure.** Deliberately did *not*
  build a server-side upload endpoint or wire up cloud object storage —
  neither exists in this codebase and neither was asked for; inventing them
  as a side effect of "show item photos" would have been scope creep beyond
  what the audit/spec called for. Instead, `src/lib/client-image.ts` decodes
  the chosen file into an off-screen `<canvas>`, resizes to a max 640px
  dimension, and re-encodes as a JPEG (quality 0.82) `data:` URL — which
  fits directly into the existing `imageUrl` text column exactly like an
  `http(s)://` URL would. This also means: no upload endpoint to secure, no
  storage credentials to configure, and any EXIF/embedded-script risk in the
  original file doesn't survive the round-trip through canvas (the output is
  flat re-encoded pixel data).
- **Validation** (`src/lib/validation/menu.ts`): a purpose-built
  `menuItemImageUrl` schema accepts an empty string (explicitly no image), an
  `http(s)://` URL, or a `data:image/(png|jpe?g|webp|gif);base64,` URL, with
  a 2,000,000-character safety cap — replacing the old bare `.url()` check
  that would have accepted an image URL but had no size bound and no
  data-URL-specific allowlist (a `data:text/html;...` or `javascript:` value
  is explicitly rejected by the new schema; both are covered by tests).
- **Shared `MenuItemThumb` component** (`src/components/MenuItemThumb.tsx`)
  is the single place that renders an item's photo, with a graceful
  `onError` fallback to a colored initial-letter tile — used identically in
  the menu manager's card grid and edit form, the POS item grid and item
  customize modal, and the public QR menu's item rows and item detail modal.
  Never a broken-image icon.
- **A real layout bug was found and fixed during this phase's screenshot
  verification** (not present in the original hand-off, caught only once a
  browser actually rendered the page): `MenuItemThumb`'s `size="lg"` was
  overloaded to mean "fill 100% of the parent" (`h-full w-full`), which is
  correct for the POS grid card and the QR menu's item-detail hero image
  (both live inside an `aspect-square`/`aspect-[16/9]` wrapper that
  constrains the size), but the QR menu's item-*row* thumbnail passed
  `size="lg"` together with a `className="h-20 w-20"` override, expecting a
  fixed 80×80 thumbnail. Because Tailwind's generated-CSS precedence isn't
  based on the order classes appear in a `className` string, `h-full`
  silently won over `h-20`, and the row's image blew up to fill its flex
  container's height with no bound — pushing the item name, price, and "Add"
  button off-screen. Fixed by splitting the overloaded value into a genuine
  fixed `"lg"` size (80×80, used by the row thumbnail with no extra
  `className` needed) and a distinct `"fill"` size (100% of parent, used by
  the two aspect-ratio-constrained hero-image call sites). Verified with a
  real screenshot before and after: before, the image filled the whole card
  and the text was pushed off-frame; after, a clean 80×80 thumbnail next to
  the name/price/Add button.
- **Unit tests**: `src/lib/validation/menu.test.ts` — 11/11 passing. Covers
  omitted/empty imageUrl, http/https URLs, the three accepted data-URL image
  types, rejection of a non-image data: URL, rejection of a bare non-URL
  string, rejection of a `javascript:` pseudo-URL, and the 2MB size cap.
- **Live end-to-end verification** with a real dev server, real Postgres, and
  real Playwright screenshots (not just component-level checks):
  - Created a menu item via the API with a real `http(s)://` image URL, one
    with no image, and one with a `data:image/jpeg;base64,...` URL — all
    accepted by the new validation.
  - Uploaded a real local JPEG file through the menu manager's edit form via
    Playwright's `setInputFiles` — confirmed via a direct DOM check that the
    resulting `<img>` tag's `src` was a proper `data:image/jpeg;base64,...`
    string produced by the client-side compression path, and confirmed
    visually via screenshot that the thumbnail preview updated to show the
    uploaded photo.
  - Screenshotted the menu manager's card grid, the POS item grid, and the
    public QR order menu (both the item list and the item-detail modal's
    hero image) all showing real, correctly-sized photos next to each item's
    name and price.
  - One of the three items used a real external `images.unsplash.com` URL —
    this sandbox's network egress doesn't allow that host (same class of
    restriction documented in `PHASE_11c_NOTES.md`/`PHASE_14_NOTES.md`), so
    that item correctly fell back to its colored-initial tile rather than a
    broken-image icon, which is itself a useful confirmation that the
    fallback path works. In a normal hosting environment with unrestricted
    egress, that same URL would just load like any other image host.

## Known gaps / deliberately deferred

- No image cropping/repositioning UI — the uploaded photo is resized to fit
  within 640px on its longest side but not cropped to a specific aspect
  ratio, so a very wide or very tall source photo may show letterboxing-style
  empty space in the fixed-aspect card slots (`aspect-square` in POS,
  `aspect-[16/9]` in the QR menu hero). Acceptable for now; a crop tool would
  be meaningful added complexity for a v1.
- No bulk photo upload/reordering.
- No server-side image moderation/content check on uploaded photos — trusted
  for now since only authenticated restaurant staff with menu-edit
  permission can upload.

## Next steps

- If restaurant owners start wanting to reuse a photo from an external CDN
  they already pay for, the plain `http(s)://` URL path already supports
  that (paste a URL instead of uploading) — no further work needed there.
- If stored data-URL rows start meaningfully bloating API response sizes for
  restaurants with very large menus, revisit with real server-side file
  storage at that point — deliberately not built ahead of that evidence.
