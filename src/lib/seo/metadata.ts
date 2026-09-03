import "server-only";
import type { Metadata } from "next";
import { absoluteUrl } from "./site";

export const SITE_NAME = "RestroKendra";

/**
 * The real 1200x630 OG/Twitter share graphic (see public/brand/og-share.png)
 * — built from the actual brand logo once a proper share-image source
 * became available, closing the gap SEO_AUDIT.md §2 originally flagged
 * ("no dedicated 1200×630 OG share image exists yet"; this used to point
 * at the square /brand/icon-512.png as a stopgap).
 */
export const DEFAULT_OG_IMAGE = "/brand/og-share.png";

/** Builds the `openGraph` block of Metadata. Exported standalone so a page with a bespoke `generateMetadata` (e.g. /site/[slug]) can still reuse the same shape. */
export function createOpenGraph({
  title,
  description,
  path,
  image = DEFAULT_OG_IMAGE,
  type = "website",
}: {
  title: string;
  description: string;
  path: string;
  image?: string;
  type?: "website" | "article";
}): NonNullable<Metadata["openGraph"]> {
  return {
    title,
    description,
    url: absoluteUrl(path),
    siteName: SITE_NAME,
    // 1200x630 matches DEFAULT_OG_IMAGE (og-share.png), the only image any
    // caller currently passes through this helper — revisit if a future
    // caller ever supplies a differently-sized `image`.
    images: [{ url: absoluteUrl(image), width: 1200, height: 630 }],
    locale: "en_US",
    type,
  };
}

/** Builds the `twitter` block of Metadata. */
export function createTwitterCard({
  title,
  description,
  image = DEFAULT_OG_IMAGE,
}: {
  title: string;
  description: string;
  image?: string;
}): NonNullable<Metadata["twitter"]> {
  return {
    card: "summary_large_image",
    title,
    description,
    images: [absoluteUrl(image)],
  };
}

/** The absolute canonical URL for a root-relative path. */
export function createCanonical(path: string): string {
  return absoluteUrl(path);
}

/**
 * Drop-in `robots` value for a real, reachable page that must never appear
 * in search results (auth utility pages, token-gated pages, internal
 * print views — see SEO_ROUTE_POLICY.md's NOINDEX table). Usage:
 * `export const metadata: Metadata = { robots: NOINDEX };`
 */
export const NOINDEX: NonNullable<Metadata["robots"]> = { index: false, follow: false };

/**
 * The main helper — composes canonical + OpenGraph + Twitter + robots into
 * one Metadata object for a standard indexable (or explicitly noindex)
 * page. Every new marketing/SEO page built in this pass uses this rather
 * than hand-assembling its own Metadata, so canonical/OG/Twitter can never
 * silently drift out of sync with each other across pages.
 */
export function createMetadata({
  title,
  description,
  path,
  ogImage,
  noindex = false,
  /** When true, `title` is used exactly as given (no " | RestroKendra" suffix) — for the homepage and any other page that already spells the brand out itself. */
  titleIsFullyFormed = false,
}: {
  title: string;
  description: string;
  path: string;
  ogImage?: string;
  noindex?: boolean;
  titleIsFullyFormed?: boolean;
}): Metadata {
  const fullTitle = titleIsFullyFormed ? title : `${title} | ${SITE_NAME}`;

  return {
    title: fullTitle,
    description,
    alternates: { canonical: createCanonical(path) },
    robots: noindex
      ? { index: false, follow: false }
      : { index: true, follow: true },
    openGraph: createOpenGraph({ title: fullTitle, description, path, image: ogImage }),
    twitter: createTwitterCard({ title: fullTitle, description, image: ogImage }),
  };
}
