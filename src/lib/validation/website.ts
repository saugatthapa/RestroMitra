import { z } from "zod";
import { WEBSITE_THEMES, MAX_GALLERY_IMAGES, MAX_FEATURED_MENU_ITEMS } from "@/lib/website-themes";
import { imageUrlSchema } from "@/lib/validation/image";

// Nepal mobile numbers, same pattern as customers.ts/staff.ts. WhatsApp
// links accept either a bare 10-digit number or one already prefixed with
// the country code — normalized at render time (website.ts), not here.
const whatsappPattern = /^(\+?977)?9[678]\d{8}$/;

const socialUrl = z
  .string()
  .trim()
  .max(300)
  .refine((v) => v === "" || /^https?:\/\//i.test(v), "Enter a full https:// link.")
  .optional()
  .or(z.literal(""));

export const websiteSocialLinksSchema = z.object({
  facebook: socialUrl,
  instagram: socialUrl,
  tiktok: socialUrl,
  website: socialUrl,
  whatsapp: z
    .string()
    .trim()
    .max(20)
    .refine((v) => v === "" || whatsappPattern.test(v), "Enter a valid WhatsApp number.")
    .optional()
    .or(z.literal("")),
});

/**
 * The full editable config, all fields optional so the dashboard's PATCH
 * endpoint can be called with a partial diff (only the section the owner
 * just edited) rather than round-tripping the entire document every save.
 */
export const updateWebsiteSchema = z.object({
  isPublished: z.boolean().optional(),
  theme: z.enum(WEBSITE_THEMES).optional(),
  tagline: z.string().trim().max(200).optional().or(z.literal("")),
  aboutText: z.string().trim().max(4000).optional().or(z.literal("")),
  heroImageUrl: imageUrlSchema(2_000_000).optional().or(z.literal("")),
  galleryImageUrls: z.array(imageUrlSchema(2_000_000)).max(MAX_GALLERY_IMAGES).optional(),
  showMenuSection: z.boolean().optional(),
  featuredMenuItemIds: z.array(z.string().uuid()).max(MAX_FEATURED_MENU_ITEMS).optional(),
  socialLinks: websiteSocialLinksSchema.optional(),
  contactPhone: z
    .string()
    .trim()
    .max(20)
    .optional()
    .or(z.literal("")),
  contactAddress: z.string().trim().max(500).optional().or(z.literal("")),
  seoTitle: z.string().trim().max(200).optional().or(z.literal("")),
  seoDescription: z.string().trim().max(300).optional().or(z.literal("")),
});
