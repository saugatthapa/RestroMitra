import type { MetadataRoute } from "next";
import { getSiteUrl } from "@/lib/seo/site";

/**
 * Blocks exactly the PRIVATE routes from SEO_ROUTE_POLICY.md — the
 * authenticated app (/dashboard, /onboarding, /billing), the platform
 * admin console (/admin), and every API route handler (/api). Everything
 * else (marketing pages, /site/[slug], the NOINDEX pages like /login)
 * stays crawlable on purpose: NOINDEX pages still need to be *reachable*
 * by crawlers that follow a real link to them (their own `noindex` meta
 * tag is what keeps them out of results — see SEO_ROUTE_POLICY.md's intro
 * for why robots.txt disallow and per-page noindex are deliberately not
 * the same mechanism). Static assets required to render any page
 * (/_next/static, /brand, icons, manifest.json) are never blocked —
 * Phase 21's own warning against accidentally blocking rendering assets.
 */
export default function robots(): MetadataRoute.Robots {
  const siteUrl = getSiteUrl();

  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/dashboard", "/onboarding", "/billing", "/admin", "/api"],
    },
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
