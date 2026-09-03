import type { MetadataRoute } from "next";
import { eq, and } from "drizzle-orm";
import { db } from "@/db";
import { restaurantWebsites, restaurants } from "@/db/schema";
import { getSiteUrl } from "@/lib/seo/site";

/**
 * Two kinds of entries: a fixed list of the marketing/SEO pages that exist
 * today (see SEO_ROUTE_POLICY.md's INDEX table — kept in sync with that
 * file by hand, since this list is short enough that a build-time content
 * scan would be over-engineering), plus every published, active
 * restaurant's public website (/site/[slug] — SEO_ROUTE_POLICY.md's
 * DYNAMIC PUBLIC row), pulled live from the DB so a newly published
 * restaurant site appears here without a code change.
 *
 * Deliberately excludes every PRIVATE/NOINDEX route from
 * SEO_ROUTE_POLICY.md — /dashboard, /admin, /api, /login, /order/[token],
 * /print/*, etc. never belong in a sitemap even though robots.txt also
 * blocks most of them; a sitemap is an index of what SHOULD be indexed,
 * not just what crawling doesn't happen to be blocked from.
 */
export const revalidate = 3600;

const STATIC_ROUTES: { path: string; changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"]; priority: number }[] = [
  { path: "/", changeFrequency: "weekly", priority: 1 },
  { path: "/restaurant-pos-nepal", changeFrequency: "weekly", priority: 0.9 },
  { path: "/features/qr-ordering", changeFrequency: "monthly", priority: 0.7 },
  { path: "/features/kds", changeFrequency: "monthly", priority: 0.7 },
  { path: "/features/inventory", changeFrequency: "monthly", priority: 0.7 },
  { path: "/compare/restrokendra-vs-restrohub", changeFrequency: "monthly", priority: 0.6 },
  { path: "/compare/restrokendra-vs-restrox", changeFrequency: "monthly", priority: 0.6 },
  { path: "/alternatives/restrohub", changeFrequency: "monthly", priority: 0.6 },
  { path: "/alternatives/restrox", changeFrequency: "monthly", priority: 0.6 },
  { path: "/privacy", changeFrequency: "yearly", priority: 0.2 },
  { path: "/terms", changeFrequency: "yearly", priority: 0.2 },
];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const siteUrl = getSiteUrl();

  const staticEntries: MetadataRoute.Sitemap = STATIC_ROUTES.map((route) => ({
    url: `${siteUrl}${route.path}`,
    changeFrequency: route.changeFrequency,
    priority: route.priority,
  }));

  const publishedSites = await db
    .select({
      slug: restaurants.slug,
      updatedAt: restaurantWebsites.updatedAt,
    })
    .from(restaurantWebsites)
    .innerJoin(restaurants, eq(restaurantWebsites.restaurantId, restaurants.id))
    .where(and(eq(restaurantWebsites.isPublished, true), eq(restaurants.isActive, true)));

  const siteEntries: MetadataRoute.Sitemap = publishedSites.map((site) => ({
    url: `${siteUrl}/site/${site.slug}`,
    lastModified: site.updatedAt,
    changeFrequency: "weekly",
    priority: 0.5,
  }));

  return [...staticEntries, ...siteEntries];
}
