import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { restaurantWebsites, menuItems, type WebsiteSocialLinks } from "@/db/schema";
import type { WebsiteTheme } from "@/lib/website-themes";

export type WebsiteConfig = typeof restaurantWebsites.$inferSelect;

/**
 * Fetches this restaurant's website row, creating a default (unpublished,
 * "classic" theme, every field empty) one on first access — mirrors the
 * "self-healing on read" precedent used elsewhere (subscription
 * reconciliation, birthday bonus) rather than requiring a dedicated
 * "create my website" onboarding step. `onConflictDoNothing` on the
 * restaurant_id unique index makes concurrent first-loads (two dashboard
 * tabs opening the Website page at once) safe — the loser's insert is a
 * no-op and the follow-up select picks up the winner's row.
 */
export async function getOrCreateWebsiteConfig(restaurantId: string): Promise<WebsiteConfig> {
  const existing = await db.query.restaurantWebsites.findFirst({
    where: eq(restaurantWebsites.restaurantId, restaurantId),
  });
  if (existing) return existing;

  await db.insert(restaurantWebsites).values({ restaurantId }).onConflictDoNothing({
    target: restaurantWebsites.restaurantId,
  });

  const row = await db.query.restaurantWebsites.findFirst({
    where: eq(restaurantWebsites.restaurantId, restaurantId),
  });
  if (!row) {
    throw new Error("Failed to create website config.");
  }
  return row;
}

export type UpdateWebsitePatch = Partial<{
  isPublished: boolean;
  theme: WebsiteTheme;
  tagline: string | null;
  aboutText: string | null;
  heroImageUrl: string | null;
  galleryImageUrls: string[];
  showMenuSection: boolean;
  featuredMenuItemIds: string[];
  socialLinks: WebsiteSocialLinks;
  contactPhone: string | null;
  contactAddress: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
}>;

/**
 * Applies a partial patch, ensuring the row exists first. Setting
 * isPublished true for the first time stamps publishedAt (kept sticky
 * across later unpublish/republish cycles, same "first-occurrence" idea as
 * loyalty's lastBirthdayBonusYear — publishedAt answers "when did this
 * site first go live", not "when was it last (re)published").
 */
export async function updateWebsiteConfig(
  restaurantId: string,
  patch: UpdateWebsitePatch,
): Promise<WebsiteConfig> {
  const current = await getOrCreateWebsiteConfig(restaurantId);

  const willPublish = patch.isPublished === true && !current.isPublished;

  const [updated] = await db
    .update(restaurantWebsites)
    .set({
      ...patch,
      publishedAt: willPublish ? new Date() : undefined,
      updatedAt: new Date(),
    })
    .where(eq(restaurantWebsites.restaurantId, restaurantId))
    .returning();

  return updated;
}

/** Content actually shown on the public site — config values, falling back to the restaurant's own profile fields where the owner hasn't overridden them. */
export function resolveWebsiteContent(
  restaurant: { name: string; phone: string | null; address: string | null; city: string | null },
  config: WebsiteConfig,
) {
  return {
    tagline: config.tagline?.trim() || null,
    aboutText: config.aboutText?.trim() || null,
    heroImageUrl: config.heroImageUrl || null,
    galleryImageUrls: config.galleryImageUrls ?? [],
    contactPhone: config.contactPhone?.trim() || restaurant.phone || null,
    contactAddress:
      config.contactAddress?.trim() ||
      [restaurant.address, restaurant.city].filter(Boolean).join(", ") ||
      null,
    seoTitle: config.seoTitle?.trim() || `${restaurant.name} — Menu & Info`,
    seoDescription:
      config.seoDescription?.trim() ||
      config.tagline?.trim() ||
      `Visit ${restaurant.name}'s page for our menu, hours, and contact info.`,
    socialLinks: (config.socialLinks ?? {}) as WebsiteSocialLinks,
  };
}

const AUTO_FEATURED_LIMIT = 8;

/**
 * The items shown in the public site's "Menu highlights" section. An
 * owner-curated `featuredMenuItemIds` list (in that exact order) wins;
 * otherwise auto-picks the first available items across active
 * categories, ordered the same way the customer-facing /order/[token] menu
 * is ordered (category sortOrder, then item sortOrder) — so a restaurant
 * that never touches this section still gets a sensible default.
 */
export async function getFeaturedMenuItems(restaurantId: string, config: WebsiteConfig) {
  const curatedIds = config.featuredMenuItemIds ?? [];

  if (curatedIds.length > 0) {
    const rows = await db
      .select({
        id: menuItems.id,
        name: menuItems.name,
        description: menuItems.description,
        imageUrl: menuItems.imageUrl,
        basePriceInPaisa: menuItems.basePriceInPaisa,
      })
      .from(menuItems)
      .where(
        and(
          eq(menuItems.restaurantId, restaurantId),
          inArray(menuItems.id, curatedIds),
          eq(menuItems.isActive, true),
        ),
      );
    const byId = new Map(rows.map((r) => [r.id, r]));
    // Preserve the owner's chosen order — a plain WHERE ... IN query does
    // not guarantee row order matches the array's order.
    return curatedIds.map((id) => byId.get(id)).filter((r): r is (typeof rows)[number] => Boolean(r));
  }

  const activeCategories = await db.query.categories.findMany({
    where: (c, { eq: eqC, and: andC }) => andC(eqC(c.restaurantId, restaurantId), eqC(c.isActive, true)),
    orderBy: (c, { asc }) => [asc(c.sortOrder)],
    with: {
      menuItems: {
        where: (mi, { eq: eqM, and: andM }) => andM(eqM(mi.isActive, true), eqM(mi.isAvailable, true)),
        orderBy: (mi, { asc }) => [asc(mi.sortOrder)],
        limit: AUTO_FEATURED_LIMIT,
        columns: { id: true, name: true, description: true, imageUrl: true, basePriceInPaisa: true },
      },
    },
  });

  const flattened = activeCategories.flatMap((c) => c.menuItems);
  return flattened.slice(0, AUTO_FEATURED_LIMIT);
}

/** Builds the public site URL for a restaurant's slug, mirroring qr.ts's buildOrderUrl. */
export function buildSiteUrl(appUrl: string, slug: string): string {
  return `${appUrl.replace(/\/$/, "")}/site/${slug}`;
}
