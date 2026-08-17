import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { restaurantWebsites, restaurants } from "@/db/schema";
import { getFeaturedMenuItems, resolveWebsiteContent } from "@/lib/website";
import { WEBSITE_THEME_CLASSES, type WebsiteTheme } from "@/lib/website-themes";
import { formatNPR } from "@/lib/money";

/**
 * Public, unauthenticated restaurant website — Website Builder, Phase 20.
 * Reached at /site/[slug], never gated behind login (same "no
 * session/auth involved" posture as /order/[token], just keyed by the
 * restaurant's own slug instead of a per-table token since there's no
 * per-visitor secret to protect here — the whole point is to be
 * discoverable). Returns 404 for an unknown slug, an inactive restaurant,
 * or a website that hasn't been published yet — an unpublished site simply
 * doesn't exist publicly, same as a draft blog post.
 */

async function loadSite(slug: string) {
  const restaurant = await db.query.restaurants.findFirst({
    where: eq(restaurants.slug, slug),
  });
  if (!restaurant || !restaurant.isActive) return null;

  const website = await db.query.restaurantWebsites.findFirst({
    where: eq(restaurantWebsites.restaurantId, restaurant.id),
  });
  if (!website || !website.isPublished) return null;

  return { restaurant, website };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const site = await loadSite(slug);
  if (!site) return { title: "Not found" };

  const content = resolveWebsiteContent(site.restaurant, site.website);
  // Social crawlers fetch og:image as a URL — a data: URL (the common case,
  // since photo uploads are client-compressed inline data with no upload
  // endpoint — see client-image.ts) can't be fetched that way, so only a
  // real http(s) hero image is offered here.
  const ogImage = content.heroImageUrl?.startsWith("http") ? content.heroImageUrl : undefined;
  return {
    title: content.seoTitle,
    description: content.seoDescription,
    openGraph: {
      title: content.seoTitle,
      description: content.seoDescription,
      images: ogImage ? [ogImage] : undefined,
    },
  };
}

const SOCIAL_LABELS: Record<string, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  tiktok: "TikTok",
  website: "Website",
};

export default async function PublicWebsitePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const site = await loadSite(slug);
  if (!site) notFound();

  const { restaurant, website } = site;
  const theme = (website.theme ?? "classic") as WebsiteTheme;
  const classes = WEBSITE_THEME_CLASSES[theme];
  const content = resolveWebsiteContent(restaurant, website);
  const featuredItems = website.showMenuSection ? await getFeaturedMenuItems(restaurant.id, website) : [];

  // "whatsapp" is rendered as its own wa.me button above, not a plain
  // link in this list — it's stored as a phone number, not a URL, so
  // treating it as one here would produce a broken href.
  const socialEntries = Object.entries(content.socialLinks).filter(
    ([key, url]) => key !== "whatsapp" && typeof url === "string" && url.trim() !== "",
  );
  const whatsappDigits = content.socialLinks.whatsapp?.replace(/[^\d]/g, "");
  // wa.me links need the full international number — a bare 10-digit
  // Nepali mobile (what most owners will type) needs the 977 country code
  // prepended, or WhatsApp can't resolve the link.
  const whatsappNumber = whatsappDigits
    ? whatsappDigits.startsWith("977")
      ? whatsappDigits
      : /^9[678]\d{8}$/.test(whatsappDigits)
        ? `977${whatsappDigits}`
        : whatsappDigits
    : undefined;

  return (
    <div className={`min-h-screen ${classes.page}`}>
      <header className="relative overflow-hidden">
        {content.heroImageUrl && (
          // A plain <img>, not next/image — this is a customer-uploaded
          // data:/http(s) URL of unknown origin/dimensions, same tradeoff
          // MenuItemThumb already makes for menu photos.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={content.heroImageUrl}
            alt=""
            className="absolute inset-0 h-full w-full object-cover opacity-25"
          />
        )}
        <div className="relative mx-auto max-w-3xl px-6 py-16 text-center">
          {restaurant.logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={restaurant.logoUrl}
              alt={restaurant.name}
              className="mx-auto mb-4 h-16 w-16 rounded-full object-cover"
            />
          )}
          <h1 className={`text-3xl font-bold sm:text-4xl ${classes.heading}`}>{restaurant.name}</h1>
          {content.tagline && <p className={`mt-3 text-lg ${classes.subtext}`}>{content.tagline}</p>}
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            {whatsappNumber && (
              <a
                href={`https://wa.me/${whatsappNumber}`}
                target="_blank"
                rel="noopener noreferrer"
                className={`rounded-full px-5 py-2 text-sm font-semibold text-white ${classes.accentBg} ${classes.accentBgHover}`}
              >
                Message us on WhatsApp
              </a>
            )}
          </div>
        </div>
      </header>

      {content.aboutText && (
        <section className="mx-auto max-w-2xl px-6 py-10">
          <h2 className={`mb-3 text-xl font-semibold ${classes.heading}`}>About</h2>
          <p className={`whitespace-pre-line text-sm leading-relaxed ${classes.subtext}`}>
            {content.aboutText}
          </p>
        </section>
      )}

      {content.galleryImageUrls.length > 0 && (
        <section className="mx-auto max-w-4xl px-6 py-10">
          <h2 className={`mb-4 text-xl font-semibold ${classes.heading}`}>Gallery</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {content.galleryImageUrls.map((url, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={`${url.slice(0, 24)}-${i}`}
                src={url}
                alt=""
                className={`aspect-square w-full rounded-lg border object-cover ${classes.border}`}
              />
            ))}
          </div>
        </section>
      )}

      {website.showMenuSection && featuredItems.length > 0 && (
        <section className="mx-auto max-w-4xl px-6 py-10">
          <h2 className={`mb-4 text-xl font-semibold ${classes.heading}`}>Menu highlights</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {featuredItems.map((item) => (
              <div key={item.id} className={`flex gap-3 rounded-lg border p-3 ${classes.card} ${classes.border}`}>
                {item.imageUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={item.imageUrl} alt="" className="h-16 w-16 shrink-0 rounded-md object-cover" />
                )}
                <div className="min-w-0">
                  <p className={`truncate text-sm font-semibold ${classes.heading}`}>{item.name}</p>
                  {item.description && (
                    <p className={`mt-0.5 line-clamp-2 text-xs ${classes.subtext}`}>{item.description}</p>
                  )}
                  <p className={`mt-1 text-sm font-semibold ${classes.accentText}`}>
                    {formatNPR(item.basePriceInPaisa)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className={`border-t px-6 py-10 ${classes.border}`}>
        <div className="mx-auto max-w-2xl text-center">
          <h2 className={`mb-3 text-xl font-semibold ${classes.heading}`}>Visit us</h2>
          {content.contactAddress && <p className={`text-sm ${classes.subtext}`}>{content.contactAddress}</p>}
          {content.contactPhone && (
            <p className={`mt-1 text-sm ${classes.subtext}`}>
              <a href={`tel:${content.contactPhone}`} className={classes.accentText}>
                {content.contactPhone}
              </a>
            </p>
          )}
          {socialEntries.length > 0 && (
            <div className="mt-4 flex flex-wrap justify-center gap-4">
              {socialEntries.map(([key, url]) => (
                <a
                  key={key}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`text-sm font-medium ${classes.accentText} hover:underline`}
                >
                  {SOCIAL_LABELS[key] ?? key}
                </a>
              ))}
            </div>
          )}
        </div>
      </section>

      <footer className={`px-6 py-6 text-center text-xs ${classes.subtext}`}>
        <a
          href="/"
          target="_blank"
          rel="noopener noreferrer"
          className="transition hover:underline"
        >
          Powered by RestroMitra
        </a>
      </footer>
    </div>
  );
}
