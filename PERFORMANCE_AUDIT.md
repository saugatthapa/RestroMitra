# Why things feel slow, and what "instant" actually means

## The honest answer on "under 100ms" first

Google's own performance standard for what "feels instant" (the RAIL model) defines
100ms as the budget for **local UI feedback to something the user just touched** —
a button visibly depressing, a tap registering — not the time for a request to
leave a phone, cross a mobile network, hit a server, query a database, and come
back. That's a different, much larger budget: Google's own guideline for a page
becoming usable at all is **5 seconds on a slow mobile connection**, 2 seconds on
a repeat visit. [Source: web.dev's RAIL article](https://web.dev/articles/rail)

For a real order → alarm-sound path specifically — customer's phone → internet →
your Hostinger server → Supabase database → back to Hostinger → out to a staff
phone over its own mobile connection — you're paying for **two separate mobile
network round trips plus a cross-datacenter database round trip**, each of which
individually can easily exceed 100ms on its own, before any of your own code even
runs. Nepal's 4G coverage is expanding but is documented as inconsistent outside
major urban centers, with real complaints about slow/unreliable connections in a
lot of areas. [Source: Kathmandu Post, April 2026](https://kathmandupost.com/science-technology/2026/04/14/4g-keeps-growing-fast-in-nepal-while-users-still-face-slow-speeds-and-patchy-coverage)

So I want to be straight with you: **literal sub-100ms for the full order-to-alarm
path isn't physically achievable**, on any restaurant app, on any hosting, over a
real mobile network. Anyone who promises you that is either lying or measuring
something different than what you're describing.

What **is** achievable, and what I found while reading through the actual code: a
meaningful chunk of the delay you're feeling right now isn't network time at all —
it's avoidable work my own code (from earlier phases of this project) is doing
before your phone even gets a chance to ring. That part I can fix. Here's exactly
what I found, ranked by how much it's actually costing you.

## What's actually making the alarm "way too late"

**1. The order takes 10-14 separate trips to the database before the alarm even
fires — most of them shouldn't be sequential.**

When a customer submits an order, my code currently does roughly: look up the
table → price the cart → open a transaction → check the table can accept orders →
insert the order → insert each cart item **one at a time in a loop** (not as one
batch) → check and update the table's status (2 more queries) → write an audit
log entry → *then* finally tell your dashboard "a new order exists." That's a
long chain, run one step after another, and each step is a real trip to your
database (which lives on Supabase, a separate provider from Hostinger — so every
one of these trips crosses the internet, it's not instant local disk I/O).

The audit log write doesn't need to happen before the alarm fires — it can happen
after, in parallel. The per-item inserts can be one batched write instead of a
loop. The table-status check can run in parallel with the order insert instead of
after it. Doing this properly could cut this chain from ~10-14 sequential trips
to roughly 3-5 — a real, measurable reduction, not a network illusion.

**2. The exact same permission check runs two or three times per request.**

The endpoint your staff use to confirm an order (which is what actually stops the
alarm) checks "does this person have access to this restaurant/branch" **three
separate times** in one request — once for the general auth check, once for
branch access, once for the specific permission — because each of those helper
functions independently re-queries instead of sharing one answer within the same
request. This pattern repeats across nearly every API route in the app, including
the ones your dashboard polls every 5 seconds. It's pure waste: same question,
same answer, asked 2-3x. Fixing this once (caching the answer for the lifetime of
a single request) speeds up almost every action in the app, not just the alarm.

**3. The alarm sound can silently fail to play at all — and there's no retry.**

Browsers block audio from playing automatically unless the user has recently
tapped something on that page. Right now, if that happens, the alarm sound is
silently swallowed — no retry, no visible warning. To a staff member, that doesn't
look like "the alarm was 2 seconds late," it looks like "the alarm didn't play
until I happened to touch the screen for something else" — which could be
anywhere from seconds to minutes later, and would very plausibly be what you're
experiencing as "way too late." This is likely a bigger contributor to what you're
seeing than the database chain above.

**4. The alarm file itself is an uncompressed 119 KB WAV.** A compressed version
of the same sound would be roughly 15-20 KB — smaller, faster to fetch on a
patchy connection, no audible quality loss for a short alert tone.

## What's making the rest of the app feel slow generally

**5. Opening the dashboard fires the same database lookups redundantly.** The
page and its surrounding layout independently re-fetch "who's logged in" and
"which restaurants do they own" — the exact same two queries, run twice, on every
single dashboard page load, because nothing shares that answer between them.
Combined with the repeated-permission-check issue above, a single dashboard open
triggers on the order of 25-35 separate database round trips in the first second
or two — the large majority of them repeating the same handful of questions.

**6. Menu photos are stored as raw base64 text directly in the database, and the
full-size photo for every single menu item is pulled down on every menu/POS page
load**, whether or not it's needed yet. For a restaurant with 40 photographed
items, that can mean several megabytes transferred just to show a list — this is
very likely the single biggest "everything feels slow" contributor specifically
on the Menu and POS pages, especially on mobile data.

**7. Your database (Supabase) and your app server (Hostinger) are two different
providers.** Every database query anywhere in the app pays real internet latency
to get there and back, not local-disk speed. If they're not in the same region,
that's an added, fixed cost on literally everything — worth checking Supabase's
project region against wherever Hostinger's hosting your app.

## What I'd fix first, in order of impact vs. effort

1. Fix the order-submission chain (parallelize/batch the database writes) — biggest, most direct win for "the alarm feels late," moderate effort.
2. Add a visible "tap to enable sound" fallback + retry when the browser blocks the alarm — directly addresses what's probably the actual worst offender, small effort.
3. Cache the repeated permission checks once per request — speeds up nearly everything in the app at once, moderate effort, very low risk.
4. Compress the alert sound files — trivial effort, real (if smaller) win.
5. De-duplicate the redundant dashboard queries — noticeably snappier dashboard opens, moderate effort.
6. Stop shipping full-size menu photos on list views (serve a small thumbnail instead, load full image only when actually opened) — biggest lever for Menu/POS feeling fast specifically, larger effort since it touches image storage.
7. Check/align your Supabase database region against your Hostinger server's region — potentially free, no-code win if they're currently mismatched.

Items 1-5 are all changes I can make directly in the code. Item 6 is a bigger,
more structural change (how images are stored) that's worth doing but is a
separate, larger piece of work. Item 7 is a one-time check you (or I, if you tell
me which regions you're on) can do in your Supabase/Hostinger dashboards.

## Bottom line

"Under 100ms" for the full round trip isn't a realistic target for any app doing
what this one does over a real mobile network — but going from what's currently a
multi-second, sometimes-silently-broken alarm to something that reliably fires
within a few hundred milliseconds of the order actually landing is realistic, and
most of the work to get there is fixing avoidable slowness in my own code, not
fighting physics.

Want me to go ahead and implement fixes 1-5 now?
