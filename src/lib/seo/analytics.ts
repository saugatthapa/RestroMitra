/**
 * Google Analytics (GA4) measurement ID — same fallback shape as
 * getSiteUrl() in ./site.ts: prefer the env var so a staging/other GA
 * property can override it, but fall back to the real production ID
 * outside development so a misconfigured deploy doesn't silently ship
 * with analytics off. Unlike APP_URL, this one deliberately has no
 * "server-only" guard — a GA measurement ID isn't a secret (it's visible
 * in every visitor's page source the moment the tag loads), and it has to
 * reach the client bundle to load gtag.js at all.
 *
 * Returns undefined in local development (no env var set) so working in
 * this repo never sends test traffic into the real GA property — see
 * RootLayout in app/layout.tsx, which only renders the gtag scripts when
 * this returns a value.
 */
const PRODUCTION_FALLBACK_GA_ID = "G-12QPHRRPNV";

export function getGaMeasurementId(): string | undefined {
  const fromEnv = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID?.trim();
  if (fromEnv) return fromEnv;
  return process.env.NODE_ENV === "production" ? PRODUCTION_FALLBACK_GA_ID : undefined;
}
