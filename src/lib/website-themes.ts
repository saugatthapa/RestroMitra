/**
 * Website Builder theme catalog — pure constants, no DB/server imports, so
 * both the dashboard editor (client component) and the public site renderer
 * (server component) can import this without pulling in server-only code.
 * Same shape/reasoning as ledger-categories.ts.
 */

export const WEBSITE_THEMES = ["classic", "modern", "warm", "midnight"] as const;
export type WebsiteTheme = (typeof WEBSITE_THEMES)[number];

export const WEBSITE_THEME_LABELS: Record<WebsiteTheme, string> = {
  classic: "Classic",
  modern: "Modern",
  warm: "Warm",
  midnight: "Midnight",
};

export const WEBSITE_THEME_DESCRIPTIONS: Record<WebsiteTheme, string> = {
  classic: "Clean white background, dark ink, a single amber accent.",
  modern: "Crisp neutral-gray surfaces with a bold indigo accent.",
  warm: "Cream background with terracotta and forest-green accents.",
  midnight: "Dark surface, light ink, a bright teal accent.",
};

/**
 * Tailwind class bundles per theme, applied to the public site's outer
 * shell and its accent-bearing elements. Kept as one lookup table (rather
 * than scattered `theme === "x" ? ... : ...` checks through the render
 * tree) so adding a 5th theme later is a one-place change.
 */
export const WEBSITE_THEME_CLASSES: Record<
  WebsiteTheme,
  {
    page: string;
    heading: string;
    subtext: string;
    accentText: string;
    accentBg: string;
    accentBgHover: string;
    card: string;
    border: string;
    // A theme-colored, semi-transparent wash placed over a hero photo. A
    // hero photo previously sat at a flat opacity with nothing else behind
    // it, so its own colors dominated the header regardless of theme — all
    // four themes looked nearly identical up top whenever a hero photo was
    // set (confirmed by screenshotting each theme with the same photo).
    // Tinting the photo with the theme's own background color keeps the
    // theme visually distinct even with a photo, and keeps header text
    // legible regardless of how bright or busy the photo is.
    heroOverlay: string;
  }
> = {
  classic: {
    page: "bg-white text-neutral-900",
    heading: "text-neutral-900",
    subtext: "text-neutral-600",
    accentText: "text-amber-600",
    accentBg: "bg-amber-500",
    accentBgHover: "hover:bg-amber-600",
    card: "bg-neutral-50",
    border: "border-neutral-200",
    heroOverlay: "bg-white/70",
  },
  modern: {
    page: "bg-neutral-100 text-neutral-900",
    heading: "text-neutral-900",
    subtext: "text-neutral-600",
    accentText: "text-indigo-600",
    accentBg: "bg-indigo-600",
    accentBgHover: "hover:bg-indigo-700",
    card: "bg-white",
    border: "border-neutral-200",
    heroOverlay: "bg-indigo-50/75",
  },
  warm: {
    page: "bg-amber-50 text-stone-900",
    heading: "text-stone-900",
    subtext: "text-stone-600",
    accentText: "text-orange-700",
    accentBg: "bg-orange-600",
    accentBgHover: "hover:bg-orange-700",
    card: "bg-white",
    border: "border-amber-200",
    heroOverlay: "bg-orange-50/70",
  },
  midnight: {
    page: "bg-neutral-950 text-neutral-100",
    heading: "text-white",
    subtext: "text-neutral-400",
    accentText: "text-teal-400",
    accentBg: "bg-teal-500",
    accentBgHover: "hover:bg-teal-400",
    card: "bg-neutral-900",
    border: "border-neutral-800",
    heroOverlay: "bg-neutral-950/70",
  },
};

export const MAX_GALLERY_IMAGES = 8;
export const MAX_FEATURED_MENU_ITEMS = 12;
