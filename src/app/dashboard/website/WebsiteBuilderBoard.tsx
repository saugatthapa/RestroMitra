"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { apiGet, apiPatch, ApiError } from "@/lib/api-client";
import { formatNPR } from "@/lib/money";
import { fileToCompressedDataUrl, ClientImageError } from "@/lib/client-image";
import { QrPosterButton } from "@/components/QrPosterButton";
import {
  WEBSITE_THEMES,
  WEBSITE_THEME_LABELS,
  WEBSITE_THEME_DESCRIPTIONS,
  WEBSITE_THEME_CLASSES,
  MAX_GALLERY_IMAGES,
  MAX_FEATURED_MENU_ITEMS,
  type WebsiteTheme,
} from "@/lib/website-themes";

type SocialLinks = {
  facebook?: string;
  instagram?: string;
  tiktok?: string;
  whatsapp?: string;
  website?: string;
};

type WebsiteConfig = {
  isPublished: boolean;
  theme: WebsiteTheme;
  tagline: string | null;
  aboutText: string | null;
  heroImageUrl: string | null;
  galleryImageUrls: string[] | null;
  showMenuSection: boolean;
  featuredMenuItemIds: string[] | null;
  socialLinks: SocialLinks | null;
  contactPhone: string | null;
  contactAddress: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
};

type MenuItem = {
  id: string;
  name: string;
  imageUrl: string | null;
  basePriceInPaisa: number;
  isActive: boolean;
  isAvailable: boolean;
};

type FormState = {
  isPublished: boolean;
  theme: WebsiteTheme;
  tagline: string;
  aboutText: string;
  heroImageUrl: string;
  galleryImageUrls: string[];
  showMenuSection: boolean;
  featuredMenuItemIds: string[];
  socialLinks: Required<SocialLinks>;
  contactPhone: string;
  contactAddress: string;
  seoTitle: string;
  seoDescription: string;
};

function toFormState(config: WebsiteConfig): FormState {
  return {
    isPublished: config.isPublished,
    theme: config.theme,
    tagline: config.tagline ?? "",
    aboutText: config.aboutText ?? "",
    heroImageUrl: config.heroImageUrl ?? "",
    galleryImageUrls: config.galleryImageUrls ?? [],
    showMenuSection: config.showMenuSection,
    featuredMenuItemIds: config.featuredMenuItemIds ?? [],
    socialLinks: {
      facebook: config.socialLinks?.facebook ?? "",
      instagram: config.socialLinks?.instagram ?? "",
      tiktok: config.socialLinks?.tiktok ?? "",
      whatsapp: config.socialLinks?.whatsapp ?? "",
      website: config.socialLinks?.website ?? "",
    },
    contactPhone: config.contactPhone ?? "",
    contactAddress: config.contactAddress ?? "",
    seoTitle: config.seoTitle ?? "",
    seoDescription: config.seoDescription ?? "",
  };
}

/**
 * The Website Builder's no-code editor — one form covering every section of
 * the public /site/[slug] page (see that route for the render side), plus
 * a publish toggle and a downloadable QR code. Saves the whole config in
 * one PATCH per "Save changes" click rather than autosaving per field —
 * simpler to reason about, and it means a half-finished edit never
 * publishes accidentally (only the isPublished toggle takes effect
 * immediately, since that one's an explicit, single-purpose action).
 */
export function WebsiteBuilderBoard({ slug, restaurantName }: { slug: string; restaurantName: string }) {
  const [form, setForm] = useState<FormState | null>(null);
  const [siteUrl, setSiteUrl] = useState("");
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [heroProcessing, setHeroProcessing] = useState(false);
  const [galleryProcessing, setGalleryProcessing] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const heroInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [websiteRes, menuRes] = await Promise.all([
        apiGet<{ website: WebsiteConfig; siteUrl: string }>(`/api/restaurants/${slug}/website`),
        apiGet<{ menuItems: MenuItem[] }>(`/api/restaurants/${slug}/menu-items`),
      ]);
      setForm(toFormState(websiteRes.website));
      setSiteUrl(websiteRes.siteUrl);
      setMenuItems(menuRes.menuItems.filter((m) => m.isActive));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load your website.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  async function persist(patch: Partial<FormState>) {
    if (!form) return;
    const next = { ...form, ...patch };
    setForm(next);
    setSaving(true);
    setError(null);
    try {
      const res = await apiPatch<{ website: WebsiteConfig; siteUrl: string }>(
        `/api/restaurants/${slug}/website`,
        {
          isPublished: next.isPublished,
          theme: next.theme,
          tagline: next.tagline,
          aboutText: next.aboutText,
          heroImageUrl: next.heroImageUrl,
          galleryImageUrls: next.galleryImageUrls,
          showMenuSection: next.showMenuSection,
          featuredMenuItemIds: next.featuredMenuItemIds,
          socialLinks: next.socialLinks,
          contactPhone: next.contactPhone,
          contactAddress: next.contactAddress,
          seoTitle: next.seoTitle,
          seoDescription: next.seoDescription,
        },
      );
      setForm(toFormState(res.website));
      setSiteUrl(res.siteUrl);
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save your website.");
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveChanges() {
    await persist({});
  }

  async function handleTogglePublish() {
    if (!form) return;
    await persist({ isPublished: !form.isPublished });
  }

  async function handleHeroFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !form) return;
    setImageError(null);
    setHeroProcessing(true);
    try {
      const dataUrl = await fileToCompressedDataUrl(file);
      setForm({ ...form, heroImageUrl: dataUrl });
    } catch (err) {
      setImageError(err instanceof ClientImageError ? err.message : "Could not process that image.");
    } finally {
      setHeroProcessing(false);
    }
  }

  async function handleGalleryFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !form) return;
    if (form.galleryImageUrls.length >= MAX_GALLERY_IMAGES) {
      setImageError(`You can add up to ${MAX_GALLERY_IMAGES} gallery photos.`);
      return;
    }
    setImageError(null);
    setGalleryProcessing(true);
    try {
      const dataUrl = await fileToCompressedDataUrl(file);
      setForm({ ...form, galleryImageUrls: [...form.galleryImageUrls, dataUrl] });
    } catch (err) {
      setImageError(err instanceof ClientImageError ? err.message : "Could not process that image.");
    } finally {
      setGalleryProcessing(false);
    }
  }

  function removeGalleryImage(index: number) {
    if (!form) return;
    setForm({ ...form, galleryImageUrls: form.galleryImageUrls.filter((_, i) => i !== index) });
  }

  function toggleFeaturedItem(itemId: string) {
    if (!form) return;
    const already = form.featuredMenuItemIds.includes(itemId);
    if (already) {
      setForm({
        ...form,
        featuredMenuItemIds: form.featuredMenuItemIds.filter((id) => id !== itemId),
      });
      return;
    }
    if (form.featuredMenuItemIds.length >= MAX_FEATURED_MENU_ITEMS) {
      setImageError(`You can feature up to ${MAX_FEATURED_MENU_ITEMS} menu items.`);
      return;
    }
    setForm({ ...form, featuredMenuItemIds: [...form.featuredMenuItemIds, itemId] });
  }

  if (loading) {
    return <div className="animate-pulse text-sm text-neutral-400">Loading your website…</div>;
  }
  if (!form) {
    return <p className="text-sm text-red-600">{error ?? "Could not load your website."}</p>;
  }

  const themeClasses = WEBSITE_THEME_CLASSES[form.theme];

  return (
    <div className="space-y-6">
      {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-600">{error}</p>}
      {imageError && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-600">{imageError}</p>}

      {/* Publish bar */}
      <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-neutral-900">
            {form.isPublished ? "Your website is live" : "Your website isn't published yet"}
          </p>
          <p className="mt-0.5 truncate text-xs text-neutral-500">{siteUrl}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {form.isPublished && (
            <a
              href={siteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-secondary text-xs"
            >
              View live site
            </a>
          )}
          <a
            href={`/api/restaurants/${slug}/website/qr`}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-secondary text-xs"
          >
            Download QR code
          </a>
          <QrPosterButton
            qrImageUrl={`/api/restaurants/${slug}/website/qr`}
            restaurantName={restaurantName}
            ctaLabel="Scan to visit our website"
            fileName={`${slug}-website-poster.png`}
            className="btn-secondary text-xs disabled:cursor-not-allowed disabled:opacity-60"
          >
            Download poster
          </QrPosterButton>
          <button
            type="button"
            disabled={saving}
            onClick={handleTogglePublish}
            className={`text-xs font-semibold disabled:opacity-50 ${
              form.isPublished ? "btn-secondary" : "btn-primary"
            }`}
          >
            {saving ? "Saving…" : form.isPublished ? "Unpublish" : "Publish website"}
          </button>
        </div>
      </div>

      {/* Theme */}
      <section className="rounded-xl border border-neutral-200 bg-white p-4">
        <h2 className="mb-1 text-sm font-semibold text-neutral-900">Theme</h2>
        <p className="mb-3 text-xs text-neutral-500">Pick a look for your public page.</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {WEBSITE_THEMES.map((theme) => {
            const isSelected = form.theme === theme;
            const swatch = WEBSITE_THEME_CLASSES[theme];
            return (
              <button
                key={theme}
                type="button"
                onClick={() => setForm({ ...form, theme })}
                className={`rounded-lg border p-3 text-left transition ${
                  isSelected ? "border-neutral-900 ring-1 ring-neutral-900" : "border-neutral-200"
                }`}
              >
                <div className={`mb-2 h-6 w-6 rounded-full ${swatch.accentBg}`} />
                <p className="text-xs font-semibold text-neutral-900">{WEBSITE_THEME_LABELS[theme]}</p>
                <p className="mt-0.5 text-[11px] leading-snug text-neutral-500">
                  {WEBSITE_THEME_DESCRIPTIONS[theme]}
                </p>
              </button>
            );
          })}
        </div>
      </section>

      {/* Hero & about */}
      <section className="rounded-xl border border-neutral-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-neutral-900">Hero & about</h2>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-500">Tagline</label>
            <input
              className="input"
              placeholder="e.g. Authentic Newari cuisine since 2010"
              value={form.tagline}
              onChange={(e) => setForm({ ...form, tagline: e.target.value })}
              maxLength={200}
            />
          </div>

          <div>
            <span className="mb-1 block text-xs font-medium text-neutral-500">Hero photo</span>
            <div className="flex items-center gap-3">
              {form.heroImageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={form.heroImageUrl}
                  alt=""
                  className="h-14 w-24 rounded-md object-cover"
                />
              ) : (
                <div className="flex h-14 w-24 items-center justify-center rounded-md bg-neutral-100 text-[10px] text-neutral-400">
                  No photo
                </div>
              )}
              <div className="flex flex-1 flex-col gap-1.5">
                <input
                  ref={heroInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleHeroFile}
                  className="hidden"
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => heroInputRef.current?.click()}
                    disabled={heroProcessing}
                    className="btn-secondary text-xs disabled:opacity-50"
                  >
                    {heroProcessing ? "Processing…" : form.heroImageUrl ? "Replace photo" : "Upload photo"}
                  </button>
                  {form.heroImageUrl && (
                    <button
                      type="button"
                      onClick={() => setForm({ ...form, heroImageUrl: "" })}
                      className="text-xs font-medium text-neutral-400 hover:text-red-600"
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-500">About</label>
            <textarea
              className="input"
              rows={4}
              placeholder="Tell customers what makes your place worth visiting."
              value={form.aboutText}
              onChange={(e) => setForm({ ...form, aboutText: e.target.value })}
              maxLength={4000}
            />
          </div>
        </div>
      </section>

      {/* Gallery */}
      <section className="rounded-xl border border-neutral-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-neutral-900">Gallery</h2>
          <span className="text-xs text-neutral-400">
            {form.galleryImageUrls.length}/{MAX_GALLERY_IMAGES}
          </span>
        </div>
        <div className="flex flex-wrap gap-3">
          {form.galleryImageUrls.map((url, i) => (
            <div key={`${url.slice(0, 24)}-${i}`} className="group relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={url} alt="" className="h-20 w-20 rounded-md object-cover" />
              <button
                type="button"
                onClick={() => removeGalleryImage(i)}
                className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-white text-xs text-neutral-500 shadow ring-1 ring-neutral-200 hover:text-red-600"
                aria-label="Remove photo"
              >
                ✕
              </button>
            </div>
          ))}
          {form.galleryImageUrls.length < MAX_GALLERY_IMAGES && (
            <button
              type="button"
              onClick={() => galleryInputRef.current?.click()}
              disabled={galleryProcessing}
              className="flex h-20 w-20 items-center justify-center rounded-md border border-dashed border-neutral-300 text-xs text-neutral-400 hover:border-neutral-400 disabled:opacity-50"
            >
              {galleryProcessing ? "…" : "+ Add"}
            </button>
          )}
          <input
            ref={galleryInputRef}
            type="file"
            accept="image/*"
            onChange={handleGalleryFile}
            className="hidden"
          />
        </div>
      </section>

      {/* Menu highlights */}
      <section className="rounded-xl border border-neutral-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-neutral-900">Menu highlights</h2>
            <p className="mt-0.5 text-xs text-neutral-500">
              Choose up to {MAX_FEATURED_MENU_ITEMS} items to feature — leave none checked to
              auto-show your first available items.
            </p>
          </div>
          <label className="flex shrink-0 items-center gap-2 text-xs text-neutral-600">
            <input
              type="checkbox"
              checked={form.showMenuSection}
              onChange={(e) => setForm({ ...form, showMenuSection: e.target.checked })}
            />
            Show on site
          </label>
        </div>
        {form.showMenuSection && (
          <div className="grid max-h-72 grid-cols-1 gap-1.5 overflow-y-auto sm:grid-cols-2">
            {menuItems.length === 0 && (
              <p className="text-xs text-neutral-400">Add some menu items first — see the Menu page.</p>
            )}
            {menuItems.map((item) => (
              <label
                key={item.id}
                className="flex items-center gap-2 rounded-md border border-neutral-100 px-2 py-1.5 text-xs hover:bg-neutral-50"
              >
                <input
                  type="checkbox"
                  checked={form.featuredMenuItemIds.includes(item.id)}
                  onChange={() => toggleFeaturedItem(item.id)}
                />
                <span className="flex-1 truncate text-neutral-800">{item.name}</span>
                <span className="text-neutral-400">{formatNPR(item.basePriceInPaisa)}</span>
              </label>
            ))}
          </div>
        )}
      </section>

      {/* Contact & social */}
      <section className="rounded-xl border border-neutral-200 bg-white p-4">
        <h2 className="mb-1 text-sm font-semibold text-neutral-900">Contact & social</h2>
        <p className="mb-3 text-xs text-neutral-500">
          Leave phone/address blank to use your restaurant profile automatically.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <input
            className="input"
            placeholder="Phone (optional override)"
            value={form.contactPhone}
            onChange={(e) => setForm({ ...form, contactPhone: e.target.value })}
          />
          <input
            className="input"
            placeholder="Address (optional override)"
            value={form.contactAddress}
            onChange={(e) => setForm({ ...form, contactAddress: e.target.value })}
          />
          <input
            className="input"
            placeholder="Facebook URL"
            value={form.socialLinks.facebook}
            onChange={(e) =>
              setForm({ ...form, socialLinks: { ...form.socialLinks, facebook: e.target.value } })
            }
          />
          <input
            className="input"
            placeholder="Instagram URL"
            value={form.socialLinks.instagram}
            onChange={(e) =>
              setForm({ ...form, socialLinks: { ...form.socialLinks, instagram: e.target.value } })
            }
          />
          <input
            className="input"
            placeholder="TikTok URL"
            value={form.socialLinks.tiktok}
            onChange={(e) =>
              setForm({ ...form, socialLinks: { ...form.socialLinks, tiktok: e.target.value } })
            }
          />
          <input
            className="input"
            placeholder="Other website URL"
            value={form.socialLinks.website}
            onChange={(e) =>
              setForm({ ...form, socialLinks: { ...form.socialLinks, website: e.target.value } })
            }
          />
          <input
            className="input"
            placeholder="WhatsApp number (98XXXXXXXX)"
            value={form.socialLinks.whatsapp}
            onChange={(e) =>
              setForm({ ...form, socialLinks: { ...form.socialLinks, whatsapp: e.target.value } })
            }
          />
        </div>
      </section>

      {/* SEO */}
      <section className="rounded-xl border border-neutral-200 bg-white p-4">
        <h2 className="mb-1 text-sm font-semibold text-neutral-900">Search & sharing</h2>
        <p className="mb-3 text-xs text-neutral-500">
          Shown in Google results and when your link is shared. Leave blank for sensible defaults.
        </p>
        <div className="space-y-3">
          <input
            className="input"
            placeholder="Page title"
            value={form.seoTitle}
            onChange={(e) => setForm({ ...form, seoTitle: e.target.value })}
            maxLength={200}
          />
          <textarea
            className="input"
            rows={2}
            placeholder="Page description"
            value={form.seoDescription}
            onChange={(e) => setForm({ ...form, seoDescription: e.target.value })}
            maxLength={300}
          />
        </div>
      </section>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleSaveChanges}
          disabled={saving}
          className="btn-primary text-sm disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
        {savedAt && !saving && <span className="text-xs text-neutral-400">Saved</span>}
      </div>

      {/* Live preview — shows the actual name/tagline/hero photo you've
          entered above (not a placeholder), so you can sanity-check the
          look before publishing without opening the live site in a new
          tab. Not a pixel-perfect match for the full public page (no
          gallery/menu/contact sections here) — just enough to judge the
          theme, hero photo, and copy together. */}
      <section className="rounded-xl border border-neutral-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-neutral-900">Preview</h2>
        <div className={`relative overflow-hidden rounded-lg border ${themeClasses.border}`}>
          {form.heroImageUrl && (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={form.heroImageUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
              <div className={`absolute inset-0 ${themeClasses.heroOverlay}`} />
            </>
          )}
          <div className={`relative p-6 text-center ${form.heroImageUrl ? "" : themeClasses.page}`}>
            <p className={`text-lg font-bold ${themeClasses.heading}`}>{restaurantName}</p>
            {form.tagline && <p className={`mt-1 text-sm ${themeClasses.subtext}`}>{form.tagline}</p>}
            <p className={`mt-3 text-xs font-semibold ${themeClasses.accentText}`}>
              This is roughly how visitors will see your page&apos;s look and colors.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
