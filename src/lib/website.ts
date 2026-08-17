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

const DAY_ORDER = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
const DAY_LABELS: Record<(typeof DAY_ORDER)[number], string> = {
  monday: "Mon",
  tuesday: "Tue",
  wednesday: "Wed",
  thursday: "Thu",
  friday: "Fri",
  saturday: "Sat",
  sunday: "Sun",
};

/** "09:00" -> "9:00 AM" — opening hours are stored as plain "HH:MM" strings
 * (see restaurants.openingHours), not Date objects, so this is a small
 * string-only formatter rather than reusing nepali-date.ts's Date-based one. */
function formatHHMM(value: string): string {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return value;
  const hour24 = Number(match[1]);
  const minute = match[2];
  const period = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${minute} ${period}`;
}

/**
 * Collected from every restaurant at onboarding (see
 * api/onboarding/restaurant/route.ts) but, until this, never actually shown
 * anywhere — not on the dashboard, not on the public site. Every restaurant
 * onboards with the SAME hours on all 7 days (the onboarding form only asks
 * once), so the common case collapses to one line; the formatter still
 * handles per-day differences correctly in case that ever changes (e.g. a
 * future "edit hours per day" settings screen).
 */
export function formatOpeningHoursSummary(
  openingHours: Record<string, { open: string; close: string } | null> | null | undefined,
): string | null {
  if (!openingHours) return null;

  const perDay = DAY_ORDER.map((day) => {
    const entry = openingHours[day];
    return { day, label: entry ? `${formatHHMM(entry.open)} – ${formatHHMM(entry.close)}` : "Closed" };
  });
  if (perDay.every((d) => d.label === "Closed")) return null;

  // Group consecutive days sharing the same label ("Mon–Sat: 9 AM – 9 PM")
  // instead of a line per day — cheap and reads far better once more than
  // one or two days are involved.
  const groups: { days: string[]; label: string }[] = [];
  for (const { day, label } of perDay) {
    const last = groups[groups.length - 1];
    if (last && last.label === label) {
      last.days.push(day);
    } else {
      groups.push({ days: [day], label });
    }
  }

  // All 7 days identical — the overwhelmingly common case today.
  if (groups.length === 1 && groups[0].days.length === 7) {
    return groups[0].label === "Closed" ? null : `Open daily · ${groups[0].label}`;
  }

  return groups
    .map((g) => {
      const names = g.days.map((d) => DAY_LABELS[d as (typeof DAY_ORDER)[number]]);
      const range = names.length > 1 ? `${names[0]}–${names[names.length - 1]}` : names[0];
      return `${range}: ${g.label}`;
    })
    .join(" · ");
}

/** Builds a Google Maps search link from a free-text address — no geocoding
 * infra needed; Maps resolves a plain-text query itself. */
export function buildDirectionsUrl(address: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

/** Content actually shown on the public site — config values, falling back to the restaurant's own profile fields where the owner hasn't overridden them. */
export function resolveWebsiteContent(
  restaurant: {
    name: string;
    phone: string | null;
    address: string | null;
    city: string | null;
    openingHours?: Record<string, { open: string; close: string } | null> | null;
  },
  config: WebsiteConfig,
) {
  const contactAddress =
    config.contactAddress?.trim() ||
    [restaurant.address, restaurant.city].filter(Boolean).join(", ") ||
    null;
  return {
    tagline: config.tagline?.trim() || null,
    aboutText: config.aboutText?.trim() || null,
    heroImageUrl: config.heroImageUrl || null,
    galleryImageUrls: config.galleryImageUrls ?? [],
    contactPhone: config.contactPhone?.trim() || restaurant.phone || null,
    contactAddress,
    directionsUrl: contactAddress ? buildDirectionsUrl(contactAddress) : null,
    openingHoursSummary: formatOpeningHoursSummary(restaurant.openingHours),
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
