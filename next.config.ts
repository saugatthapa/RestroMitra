import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

/**
 * Phase 2 (P1) — production security headers.
 *
 * This is deliberately the "Without Nonces" CSP pattern from Next's own
 * docs (nextjs.org/docs/app/guides/content-security-policy), not a
 * nonce-based strict CSP, and that's a considered trade-off, not an
 * oversight:
 *
 *   - A nonce-based CSP requires EVERY page to be dynamically rendered
 *     (Next parses the nonce out of the CSP response header at render
 *     time) — that would force the public QR order page, the public
 *     restaurant website builder pages, the print/KOT page, and /login
 *     /register off static optimization, a real architectural change
 *     with real hosting-cost and latency implications on a
 *     single-instance Hostinger deployment, not something to gamble on
 *     without Playwright E2E coverage across every affected route first
 *     (tracked separately — see the E2E testing task).
 *   - This codebase also has ~30+ inline `style={{...}}` usages (floor
 *     plan table positioning, chart bars, dynamic layout) that a
 *     nonce-based `style-src` would break outright — migrating those to
 *     CSS classes/custom properties is its own real refactor, not
 *     something to bundle silently into a "security headers" pass.
 *
 * `script-src`/`style-src` therefore keep `'unsafe-inline'` — a real,
 * explicitly-acknowledged gap in XSS defense-in-depth (this CSP does NOT
 * block a successful inline-script injection), but every other CSP
 * directive here is as strict as this app's actual code allows, verified
 * against this codebase specifically (grepped for dangerouslySetInnerHTML,
 * inline <script> tags, external fonts/analytics/tracking scripts, and
 * client-side fetches to third-party hosts — none exist). Removing
 * 'unsafe-inline' is real, valuable follow-up work once nonce-based
 * dynamic rendering can be verified end-to-end.
 *
 * `form-action` explicitly allow-lists eSewa's hosted payment form
 * endpoints (both production and the rc- staging host — the deployed env
 * decides which one is actually used, see src/lib/payment-gateways/
 * config.ts) because GatewayPaymentButtons.tsx does a REAL browser
 * `<form method="POST" action="https://epay.esewa.com.np/...">` — a bare
 * `form-action 'self'` would silently break real payments in production.
 * Khalti's checkout is a `window.location.href` redirect, not a form
 * submission, so it isn't governed by `form-action` at all and needs no
 * CSP allowance.
 *
 * HSTS is set WITHOUT `preload` deliberately — preload-list submission is
 * a hard-to-reverse, domain-wide commitment (every subdomain, forever,
 * until the list propagates a removal) that should be an explicit choice
 * by whoever owns the domain, not something bundled into this pass.
 *
 * Caveat I cannot verify from this sandbox: whether Hostinger's own
 * reverse proxy in front of the Node.js app passes these response headers
 * through unmodified. Confirm with the browser's Network tab against the
 * live deployment after this ships.
 */
const isDev = process.env.NODE_ENV === "development";

const cspDirectives = [
  `default-src 'self'`,
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  `style-src 'self' 'unsafe-inline'`,
  `img-src 'self' data: blob:`,
  `font-src 'self' data:`,
  `connect-src 'self'`,
  `worker-src 'self'`,
  `object-src 'none'`,
  `base-uri 'self'`,
  // eSewa's hosted checkout form — see the module comment above. Both
  // hosts are always allow-listed (not gated on NODE_ENV) since which one
  // is actually reachable depends on ESEWA_ENV at runtime, not the Next
  // build mode.
  `form-action 'self' https://epay.esewa.com.np https://rc-epay.esewa.com.np`,
  `frame-ancestors 'none'`,
  `block-all-mixed-content`,
  `upgrade-insecure-requests`,
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: cspDirectives },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), midi=(), interest-cohort=()",
  },
  // 180 days, applies to subdomains, deliberately no `preload` — see the
  // module comment above.
  { key: "Strict-Transport-Security", value: "max-age=15552000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

/**
 * Phase 2 (P1) — error monitoring. `withSentryConfig` wires up Sentry's
 * build-time instrumentation (source map upload, automatic route
 * annotation) — but only when SENTRY_ORG/SENTRY_PROJECT are actually set.
 * Without them this is a plain passthrough (`nextConfig` unwrapped), so
 * every environment that hasn't configured Sentry yet — this sandbox,
 * anyone's local dev, CI — builds exactly as before this file changed.
 * SENTRY_AUTH_TOKEN (needed only for source map upload, not for error
 * capture itself) is intentionally allowed to be unset even when
 * org/project ARE set: `silent: true` keeps a missing-token warning from
 * failing the build, since a working Sentry project can exist with
 * source maps not yet wired up. See SENTRY_SETUP.md for the full picture
 * — the actual Sentry.init() calls (and their redaction rules) live in
 * instrumentation-client.ts / sentry.server.config.ts / sentry.edge.config.ts,
 * independent of this build-time wrapper.
 */
const sentryOrg = process.env.SENTRY_ORG;
const sentryProject = process.env.SENTRY_PROJECT;

export default sentryOrg && sentryProject
  ? withSentryConfig(nextConfig, {
      org: sentryOrg,
      project: sentryProject,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      silent: true,
      widenClientFileUpload: true,
      webpack: {
        treeshake: { removeDebugLogging: true },
      },
      // Routes error-report traffic through this app's own origin instead
      // of directly to sentry.io. This isn't optional here the way it is
      // in most Sentry setups: this file's CSP above sets `connect-src
      // 'self'`, which would flatly BLOCK the browser SDK's default
      // direct POST to `*.sentry.io` — every client-side error report
      // would silently vanish, not just the ones an ad-blocker happens to
      // catch. Sentry's Next.js integration serves this route itself;
      // nothing else in this app needs to handle it.
      tunnelRoute: "/monitoring-tunnel",
    })
  : nextConfig;
