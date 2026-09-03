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
 */
const PRODUCTION_FALLBACK = "https://restrokendra.com";

export function getSiteUrl(): string {
  const raw = process.env.APP_URL?.trim();
  const looksLikeRealDomain = !!raw && !/localhost|127\.0\.0\.1/.test(raw);

  if (looksLikeRealDomain) {
    return raw!.replace(/\/+$/, "");
  }
  if (process.env.NODE_ENV === "production") {
    return PRODUCTION_FALLBACK;
  }
  return (raw || "http://localhost:3000").replace(/\/+$/, "");
}

/** Resolves a root-relative path (or passes an already-absolute URL through) against the site URL. */
export function absoluteUrl(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  const base = getSiteUrl();
  return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}
