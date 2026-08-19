# Deploying this update (Web Push notifications + branch-switcher fix)

Two things happened in this update: real push notifications (works even with the
app fully closed) and a fix so the branch dropdown actually changes the dashboard
numbers. Follow these in order — the notification feature won't work at all if you
skip the VAPID/migration steps.

## Step 1 — Generate your VAPID keypair

Do this once, on your own computer (not on Hostinger). This is the "identity" your
server uses to sign push messages — never share the private key or reuse someone
else's.

```bash
npx web-push generate-vapid-keys
```

This prints something like:

```
=======================================

Public Key:
BJ5zEzPjHx6JNwgS2N1pYPI0LfhgXnEmIp5tZ8H1PWYCzgUz_z8e5mW3PhNgRhJTHKEVLCl7yfDZP-Muf1EjXJ0

Private Key:
ygX8FIdl-vKhI7L2LzQLM_kdI3AMesLxRdhKcXsn_-c

=======================================
```

Copy both values somewhere safe — you'll paste them into Hostinger in Step 3.

## Step 2 — Pull the update into your local copy

In the `RestroMitra` folder on your computer (where I just saved
`restromitra-phase25.bundle`):

```bash
cd path\to\RestroMitra
git bundle verify restromitra-phase25.bundle
git pull restromitra-phase25.bundle main
```

If `git pull` complains about uncommitted local changes, commit or stash them
first (`git stash`), then re-run the pull.

Then get the new dependency (`web-push`) installed and confirm everything's still
in order:

```bash
npm install
npm run build
```

If the build finishes without errors, the code side is good.

## Step 3 — Set the three new environment variables in Hostinger

In your Hostinger **hPanel → Websites → [your site] → Advanced → Node.js** (the
same screen where `DATABASE_URL`, `AUTH_SECRET`, etc. are already set), add:

| Variable | Value |
|---|---|
| `VAPID_PUBLIC_KEY` | the "Public Key" from Step 1 |
| `VAPID_PRIVATE_KEY` | the "Private Key" from Step 1 |
| `VAPID_SUBJECT` | `mailto:` + an email you control, e.g. `mailto:you@yourdomain.com` |

Save. Don't restart the app yet — do that after Step 5.

## Step 4 — Get the updated code onto the Hostinger server

This is the one step that depends on however you currently publish updates to
Hostinger (SSH + git pull on the server, Hostinger's Git deploy feature, or a
manual upload) — I don't have that specific detail on hand for this session. If
you SSH into the Hostinger server and pull from your own Git remote there, it's:

```bash
cd /path/to/app/on/hostinger
git pull origin main
npm install
```

If you deploy a different way (zip upload, Hostinger's built-in Git deploy button,
etc.), use whatever you'd normally do to get this same commit onto the server —
just make sure `npm install` runs afterward so `web-push` is actually installed
there too. Let me know which method you use if you'd like the exact commands.

## Step 5 — Run the database migration (production)

This is a new required step this update introduces — it creates the table that
stores each device's push subscription. Run it once, pointed at your **production**
database (from your own computer is fine, or from the Hostinger server if you're
SSHed in — either works, since it just needs `DATABASE_URL`/`DIRECT_URL`):

```bash
DATABASE_URL="<your production DATABASE_URL>" DIRECT_URL="<your production DIRECT_URL>" npm run db:migrate
```

You should see `Migrations complete.` at the end.

## Step 6 — Build and restart

On the Hostinger server:

```bash
npm run build
```

Then restart the Node.js app the same way you always do (Hostinger's hPanel has a
**Restart** button on the Node.js app screen — use that, or your usual
`npm start` / process manager restart if you run it manually).

## Step 7 — Clear the old service worker cache on staff phones

`public/dashboard-sw.js` changed in this update (it now handles push
notifications), so any phone with the app already installed is running the old
cached version until it picks up the new one. On each staff phone:

1. Open the installed app (or the dashboard in the browser).
2. Fully close it (swipe it away from recent apps, not just switch away).
3. Reopen it — this lets the browser fetch and activate the new service worker.
4. Tap **"Turn on notifications"** again if it's shown (this re-subscribes the
   device to push, which didn't exist before this update — even someone who
   already had notification permission granted needs this one-time reopen for
   the actual subscription to be created).

## Step 8 — Verify

- Place a test order from a second phone/browser while the dashboard app is
  **completely closed** on a staff phone (not just backgrounded) — a system
  notification should appear within a few seconds.
- Open the dashboard and switch branches in the header dropdown — the stat
  tiles ("Today's sales", "Orders today", etc.) should visibly change to match
  the selected branch.

If a notification doesn't show up, the most common cause is Step 3 or Step 7
being skipped — double check the three `VAPID_*` variables are actually set on
the live Hostinger app (not just saved in a form that didn't apply), and that the
phone actually did a full close-and-reopen after the deploy.
