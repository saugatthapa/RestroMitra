# Deployment — current state and how to change it

This is the short, current-state answer to "how does this app get deployed,
and what would it take to automate it?" The detailed how-tos it points to
already exist elsewhere in this repo — this file doesn't repeat them, it
tells you which one to read.

## Today: manual SSH deploy (this is really what happens)

The live, verified deployment target is a single-instance Hostinger Node.js
app, deployed by hand over SSH: `git pull` (or `fetch` + `reset --hard`),
`npm ci`, `npm run db:migrate`, `npm run build`, then a restart. See:

- README's **"Deploying"** section for why single-instance is a hard
  requirement (the in-memory rate limiter) and for the Vercel/Netlify
  alternatives.
- `DEPLOY_PHASE25.md` for the concrete, currently-accurate manual runbook
  (the exact commands, in order, including the Passenger restart trick).

Nothing about this is automated today. A push to `main` does not deploy
anything by itself — someone has to SSH in and run the commands.

## What exists but is deliberately switched off: CI-gated deploy

`.github/workflows/ci.yml` has a `deploy` job that automates the exact
manual sequence above (same commands, same order — it doesn't invent a new
deploy process) and runs it automatically after every push to `main` that
passes the full `verify` job (lint, typecheck, the whole test suite, the
production build, and the E2E suite).

**This job is off.** It is gated behind a repository Variable,
`DEPLOY_ENABLED`, that defaults to unset — until a human deliberately sets it
to `true`, the job is skipped on every run and never attempts to reach any
server. This is intentional, not an oversight: this workflow file has no way
to know the real SSH host, deploy path, or restart command for whoever's
actual Hostinger account is hosting this app, and guessing at those would be
actively unsafe. Turning it on is a deployment decision for whoever controls
the real server, not something to fabricate from inside a repo checkout.

**Before flipping it on**, see `CI_GATED_DEPLOY_SETUP.md` for the full
checklist:

1. Generate a dedicated SSH deploy key (don't reuse a personal one).
2. Add it, plus the host/user/port/app-path, as four repository **Secrets**.
3. Confirm the restart command in the workflow's last remote step actually
   matches this account's Hostinger setup (Passenger vs. PM2 vs. something
   else) — edit it if not.
4. Do one full deploy by hand with the new key first, to confirm every
   command in the automated sequence actually works against the real server.
5. (Strongly recommended) Add a required-reviewer rule to the `production`
   GitHub Environment, so every automated deploy pauses for a human approval
   click, not just a green test run.
6. Only then, set the `DEPLOY_ENABLED` repository **Variable** to `true`.

Until all of that is done, manual SSH deploy (above) remains the real
process — and that's the honest, current state of this project, not a gap to
paper over.

## Database backups

Covered separately in `BACKUP_RESTORE.md` — includes the (now automated, see
that file) scheduled backup job, retention policy, and restore-verification
procedure.
