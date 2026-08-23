# Error monitoring (Sentry) — setup

Phase 2 (P1) deliverable. This is wired up but **inert** — nothing is
sent anywhere until you set the environment variables below. I can't
create a Sentry account or project on your behalf, so this document is
the rest of the task: what to do to actually turn it on.

## What's already done

- `@sentry/nextjs` is installed and configured (`instrumentation-client.ts`,
  `sentry.server.config.ts`, `sentry.edge.config.ts`, `instrumentation.ts`),
  covering the browser, the Node.js server runtime, and the edge runtime.
- `next.config.ts`'s `headers()` (the P1 CSP work) already allow-lists
  nothing for Sentry — deliberately, because error reports are tunneled
  through this app's own origin (`/monitoring-tunnel`, wired by
  `withSentryConfig` automatically) instead of going directly to
  `*.sentry.io`. Without this, the CSP's `connect-src 'self'` would
  silently block every client-side error report — not an edge case, the
  default behavior.
- **Redaction rules** (`src/lib/sentry-redact.ts`, unit tested in
  `src/lib/sentry-redact.test.ts`): request/response bodies and cookies
  are disabled at the SDK level (`dataCollection: { httpBodies: [],
  cookies: false }`), and a `beforeSend` hook additionally strips known
  sensitive fields (password, phone, customerPhone, customerName, email,
  panVat, cookies, auth headers, session ids) from whatever's left —
  `extra`/`contexts`/breadcrumbs — plus specifically redacts the QR order
  token out of any captured URL (`/order/[token]` is a bearer-credential
  URL by this app's own design, see that route's doc comment).
- Every init file no-ops (skips `Sentry.init` entirely) when its DSN env
  var isn't set — confirmed by running the full test suite, the E2E
  suite, and a full production build with no Sentry env vars set at all
  (this sandbox has none) — nothing changed in the app's behavior.

## What you need to do

1. **Create a Sentry account and a Next.js project** at
   [sentry.io](https://sentry.io) (or self-hosted, if your org runs
   that) — a few minutes, free tier is fine to start.
2. From the project's Settings → Client Keys (DSN) page, copy the DSN.
   Set it as **both**:
   - `NEXT_PUBLIC_SENTRY_DSN` — used by `instrumentation-client.ts` (the
     `NEXT_PUBLIC_` prefix is required for a browser-side env var in
     Next.js; this value is not secret — DSNs are meant to be public,
     they only allow *sending* events, not reading your project's data).
   - `SENTRY_DSN` — used by `sentry.server.config.ts` / `sentry.edge.config.ts`.
     Same value as above; kept as two separate vars because one is
     baked into the client bundle at build time and the other stays
     server-only, matching the SDK's own convention.
3. **Optional but recommended** — source map upload, so stack traces in
   Sentry show your actual source instead of minified bundle code:
   - `SENTRY_ORG` — your org slug (from the URL, e.g. `sentry.io/organizations/<this>/`).
   - `SENTRY_PROJECT` — the project slug you created.
   - `SENTRY_AUTH_TOKEN` — Settings → Auth Tokens → create one with
     `project:releases` scope. Treat this as a secret (same handling as
     `AUTH_SECRET`/`VAPID_PRIVATE_KEY` — never commit it, only set it in
     Hostinger's environment configuration).
   - Without `SENTRY_ORG`/`SENTRY_PROJECT` set, `next.config.ts` skips
     `withSentryConfig` entirely and builds exactly as it does today —
     error capture still works via the DSN alone, you just won't get
     source-mapped stack traces.
4. **Optional** — `SENTRY_ENVIRONMENT` (server) /
   `NEXT_PUBLIC_SENTRY_ENVIRONMENT` (client), e.g. `production` /
   `staging`, so events from different deploys don't mix together in
   Sentry's UI. Defaults to `NODE_ENV` if unset.
5. Set all of the above in Hostinger's environment configuration (same
   place `DATABASE_URL`/`AUTH_SECRET`/`VAPID_*` already live), redeploy,
   then trigger a real error (anything — even a deliberate one, like
   temporarily throwing in a route handler) and confirm it shows up in
   Sentry's Issues page before considering this actually live.

## Known trade-off, stated honestly

Loading the Sentry browser SDK (a static `import * as Sentry from
"@sentry/nextjs"` in `instrumentation-client.ts`, matching Sentry's own
documented pattern) adds roughly 80KB to the client's shared JS bundle,
measured via this session's own production build
(`First Load JS shared by all` went from ~103KB to ~184KB) — **even
though `Sentry.init()` itself never runs while the DSN is unset**. The
`if (dsn)` guard prevents anything from being *sent*, but doesn't prevent
the SDK code from being *shipped*, because it's a static import, not a
dynamic one. On a single-instance Hostinger deployment serving a
mobile-heavy Nepali audience (this codebase's own recurring performance
concern elsewhere — see `PERFORMANCE_AUDIT.md`), that's a real cost worth
knowing about before deciding whether/when to turn this on, not something
to discover after the fact. If bundle size matters more than the
convenience of a static import, converting `instrumentation-client.ts` to
a dynamic `import()` gated on the DSN check is a real, well-scoped follow-up
(not done this pass) — the trade-off there is losing the router-transition
breadcrumb feature, which needs to be wired synchronously at module load.
