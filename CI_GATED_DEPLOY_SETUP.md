# CI-gated deploy — setup

Closes the last item on the P2 backlog `FINAL_HARDENING_REPORT.md` flagged: "No
CI-gated production deploy (manual SSH/Hostinger deploy decoupled from CI green
status — a process/runbook decision, not a code fix)."

`.github/workflows/ci.yml` now has a second job, `deploy`, that automates exactly
the manual steps `DEPLOY_PHASE25.md` already documents (SSH in, `git reset --hard
origin/main`, `npm ci`, `npm run db:migrate`, `npm run build`, restart) — it
doesn't invent a new deploy process, it runs the existing one automatically,
gated behind `needs: verify` so it only ever fires after lint, typecheck, the
full test suite, the production build, and the E2E suite have all passed on a
real push to `main`.

**This job is off by default.** Merging it changes nothing about how deploys
happen today until you deliberately turn it on, below. Nothing in it can reach
your server with the repository in its current state.

## Why it's safe to merge before you're ready to enable it

The job's `if:` condition checks a repository **Variable** (not a Secret) called
`DEPLOY_ENABLED`. Until that variable is set to the literal text `true`, GitHub
Actions skips the job outright — it doesn't run, doesn't attempt an SSH
connection, doesn't touch anything. You can merge this today and flip the switch
whenever you're ready, on your own schedule.

## What to configure before enabling it

### 1. A dedicated SSH key for GitHub Actions

Don't reuse your personal SSH key. Generate a fresh keypair just for this:

```bash
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ./gh-actions-deploy-key -N ""
```

This produces `gh-actions-deploy-key` (private) and `gh-actions-deploy-key.pub`
(public).

On the Hostinger server, add the **public** key to the deploy user's
`~/.ssh/authorized_keys` (append it — don't overwrite the file if anything's
already there):

```bash
cat gh-actions-deploy-key.pub >> ~/.ssh/authorized_keys
```

Keep the **private** key (`gh-actions-deploy-key`, no `.pub`) — that's what goes
into GitHub in step 2. Don't commit either file to the repository.

### 2. Add these as repository Secrets

GitHub → your repo → **Settings → Secrets and variables → Actions → Secrets** →
**New repository secret**, one at a time:

| Secret name | Value |
|---|---|
| `HOSTINGER_SSH_HOST` | Your server's hostname or IP (same one you already SSH to by hand) |
| `HOSTINGER_SSH_USER` | The SSH username you deploy as |
| `HOSTINGER_SSH_PORT` | The SSH port (usually `22`, but confirm — some Hostinger plans use a custom one) |
| `HOSTINGER_SSH_KEY` | The full contents of the **private** key file from step 1 (`cat gh-actions-deploy-key`) — paste the whole thing, including the `-----BEGIN...-----`/`-----END...-----` lines |
| `HOSTINGER_APP_PATH` | The absolute path to this app's checkout on the server (e.g. `/home/youruser/RestroMitra`) |

### 3. Confirm the restart command matches your actual setup

The workflow's last remote step is:

```bash
mkdir -p tmp && touch tmp/restart.txt
```

That's the standard restart trigger for **Phusion Passenger**, which is what
Hostinger's Node.js hosting uses by default — touching that file tells Passenger
to reload the app on its next request. If your account is set up differently (a
custom PM2 process, a different process manager, Hostinger's own restart API),
**this line needs to change** to whatever you actually use — the same command you
run by hand today after Step 6 of `DEPLOY_PHASE25.md`. Edit the last step of the
`deploy` job in `.github/workflows/ci.yml` before enabling.

### 4. Do one full deploy by hand first, right after adding the secrets

Before flipping `DEPLOY_ENABLED` on, SSH in using the **new** deploy key
specifically (not your personal one) and confirm it can actually reach the
server and run each command in the remote script by hand:

```bash
ssh -i ./gh-actions-deploy-key -p <port> <user>@<host>
cd <app path>
git fetch origin main && git reset --hard origin/main
npm ci
npm run db:migrate
npm run build
mkdir -p tmp && touch tmp/restart.txt
```

If every line succeeds cleanly, the automated version will too — it's the exact
same sequence.

### 5. Turn it on

GitHub → your repo → **Settings → Secrets and variables → Actions → Variables**
tab (not Secrets) → **New repository variable**:

| Name | Value |
|---|---|
| `DEPLOY_ENABLED` | `true` |

From this point on, every push to `main` that passes the full `verify` job
(lint/typecheck/test/build/e2e) will automatically deploy. Watch the first one
in the **Actions** tab to confirm it behaves the way step 4's manual run did.

## Turning it back off

Delete the `DEPLOY_ENABLED` variable, or set it to anything other than `true` —
the job goes back to being skipped on every run, with zero code changes needed.

## What this deliberately does NOT change

- `AUTH_SECRET`, `DATABASE_URL`, `VAPID_*`, and every other production
  environment variable stay exactly where they already are — Hostinger's own
  Node.js environment-variable panel. This workflow never sees or touches them;
  it only runs `npm run build`/`npm run db:migrate` on the server, which read
  those from the server's own environment the same way they always have.
- The migration step (`npm run db:migrate`) runs unconditionally on every
  deploy, same as the manual runbook — if a migration is destructive or needs a
  manual data-safety check first (see `MIGRATION_SAFETY.md`), do that check
  BEFORE merging the PR that triggers this deploy, not after.
