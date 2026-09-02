# CI VAPID secrets — one-time setup required

`.github/workflows/ci.yml`'s `verify` job (the one that runs lint/typecheck/
tests/build/E2E on every push) used to hardcode a throwaway VAPID keypair
directly in the workflow file. That keypair was never used to send a real push
notification to a real subscriber — it only exists so `push.ts`'s
`ensureConfigured()` succeeds in CI and the push-integration tests can exercise
the real send path (mocked at the network layer). Still, committing any real
private key in plaintext — however inert — is exactly what secret scanners and
security audits flag, so it's been moved to GitHub Actions secrets instead.

**This means `verify` will fail at the Test step until you add two repository
secrets — do this before your next push, or you'll see the same kind of CI
failure this change was meant to fix.**

## What to add

GitHub → this repo → **Settings → Secrets and variables → Actions → Secrets** →
**New repository secret**:

| Secret name | Value |
|---|---|
| `CI_VAPID_PUBLIC_KEY` | `BJIH8a01bovnYC6k0GsNUpGb7BEsEDn3UznqhO3xpwSh-JICdCQ3eICiN_316x27M6D9Fk3lE-11bdFVvEYw2kM` |
| `CI_VAPID_PRIVATE_KEY` | `ABDhYexfV7fJibsk6IZubuqEOpydJ_dCBafcjvUdBJI` |

This is a **freshly generated, throwaway keypair** (via
`node -e "console.log(require('web-push').generateVAPIDKeys())"`), not
connected to production in any way — production's real VAPID keys already live
only in Hostinger's own environment configuration, untouched by this change.
You're welcome to generate your own pair instead and use that; any structurally
valid keypair works identically here, since CI never actually delivers a push
notification with it.

Once both secrets are set, every future `verify` run picks them up automatically
— no further action needed, and nothing else about the workflow changes.
