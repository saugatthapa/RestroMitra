import { describe, expect, it } from "vitest";
import { updateWebsiteSchema, websiteSocialLinksSchema } from "./website";

describe("updateWebsiteSchema", () => {
  it("accepts a minimal partial update", () => {
    const parsed = updateWebsiteSchema.safeParse({ isPublished: true });
    expect(parsed.success).toBe(true);
  });

  it("accepts a full config", () => {
    const parsed = updateWebsiteSchema.safeParse({
      isPublished: true,
      theme: "modern",
      tagline: "Best momo in town",
      aboutText: "We've been serving since 2010.",
      heroImageUrl: "https://example.com/hero.jpg",
      galleryImageUrls: ["https://example.com/1.jpg", "https://example.com/2.jpg"],
      showMenuSection: true,
      featuredMenuItemIds: ["2de90371-1e63-4e56-a7cb-2d8ecec8a40f"],
      socialLinks: { facebook: "https://facebook.com/img", whatsapp: "9812345678" },
      contactPhone: "9812345678",
      contactAddress: "Kathmandu",
      seoTitle: "Img Restaurant",
      seoDescription: "Great food.",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an invalid theme", () => {
    const parsed = updateWebsiteSchema.safeParse({ theme: "neon" });
    expect(parsed.success).toBe(false);
  });

  it("rejects a hero image that isn't http(s) or a data URL", () => {
    const parsed = updateWebsiteSchema.safeParse({ heroImageUrl: "javascript:alert(1)" });
    expect(parsed.success).toBe(false);
  });

  it("rejects more gallery images than the cap", () => {
    const many = Array.from({ length: 20 }, (_, i) => `https://example.com/${i}.jpg`);
    const parsed = updateWebsiteSchema.safeParse({ galleryImageUrls: many });
    expect(parsed.success).toBe(false);
  });

  it("rejects a non-uuid featured menu item id", () => {
    const parsed = updateWebsiteSchema.safeParse({ featuredMenuItemIds: ["not-a-uuid"] });
    expect(parsed.success).toBe(false);
  });
});

describe("websiteSocialLinksSchema", () => {
  it("accepts empty strings for every field", () => {
    const parsed = websiteSocialLinksSchema.safeParse({
      facebook: "",
      instagram: "",
      tiktok: "",
      website: "",
      whatsapp: "",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a facebook link without a protocol", () => {
    const parsed = websiteSocialLinksSchema.safeParse({ facebook: "facebook.com/img" });
    expect(parsed.success).toBe(false);
  });

  it("accepts a WhatsApp number with the +977 prefix", () => {
    const parsed = websiteSocialLinksSchema.safeParse({ whatsapp: "+9779812345678" });
    expect(parsed.success).toBe(true);
  });

  it("rejects an obviously invalid WhatsApp number", () => {
    const parsed = websiteSocialLinksSchema.safeParse({ whatsapp: "12345" });
    expect(parsed.success).toBe(false);
  });
});
