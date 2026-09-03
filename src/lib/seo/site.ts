import "server-only";

/**
 * Single source of truth for the app's own absolute URL. Every SEO surface
 * that needs one (generateMetadata, sitemap.ts, robots.ts, JSON-LD) runs
 * server-side only in the App Router, so there's no need for a
 * NEXT_PUBLIC_ variant reachable from the browser.
 *
 * Deliberately reuses the existing `APP_URL` env var already used across
 * this app for absolute-URL construction (password reset emails, table QR
 * codes, payment gateway callback URLs, website QR codes — see
 * .env.example and the 8 existing call sites) rather than introducing a
 * second "the app's URL" variable that could drift out of sync with it.
 *
 * Production MUST set `APP_URL=https://restrokendra.com` in its actual
 * deploy environment (Hostinger/Vercel env vars) — this file cannot set
 * that for you. In its absence outside development, this falls back to
 * the documented production domain so a misconfigured prod deploy can
 * never ship a localhost canonical/OG URL — never guess or hardcode
 * localhost into anything user- or crawler-facing.
 *
 * Also tolerates the common misconfiguration of setting APP_URL to a bare
 * domain with no scheme (e.g. "restrokendra.com" instead of
 * "https://restrokendra.com") — the 8 pre-existing call sites that read
 * process.env.APP_URL directly (password reset emails, table/website QR
 * codes, payment gateway callbacks) never noticed this because they only
 * ever string-concatenate it; `new URL(getSiteUrl())` in the root layout's
 * metadataBase is the first caller that actually parses it, which is why
 * a scheme-less APP_URL surfaces here as a hard build failure ("Invalid
 * URL") instead of silently producing broken links like it always has
 * elsewhere. Fixed at the source so every consumer gets a valid URL.
 */
const PRODUCTION_FALLBACK = "https://restrokendra.com";

export function getSiteUrl(): string {
  const raw = process.env.APP_URL?.trim();
  const looksLikeRealDomain = !!raw && !/localhost|127\.0\.0\.1/.test(raw);

  if (looksLikeRealDomain) {
    const withScheme = /^https?:\/\//.test(raw!) ? raw! : `https://${raw}`;
    return withScheme.replace(/\/+$/, "");
  }
  if (process.env.NODE_ENV === "production") {
    return PRODUCTION_FALLBACK;
  }
  const fallback = raw || "http://localhost:3000";
  const withScheme = /^https?:\/\//.test(fallback) ? fallback : `http://${fallback}`;
  return withScheme.replace(/\/+$/, "");
}

/** Resolves a root-relative path (or passes an already-absolute URL through) against the site URL. */
export function absoluteUrl(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  const base = getSiteUrl();
  return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}
