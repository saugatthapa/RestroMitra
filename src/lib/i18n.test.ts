import { describe, it, expect } from "vitest";
import {
  translate,
  trialDaysLeftText,
  cartItemCountText,
  LOCALE_LABELS,
  type TranslationKey,
} from "./i18n-dictionary";

// A representative sample of keys from each translated surface (dashboard
// nav/chrome, public ordering menu) — not exhaustive, but enough to catch a
// systemic mistake (e.g. every "ne" value accidentally left empty) without
// hand-listing all ~50 dictionary keys here.
const SAMPLE_KEYS: TranslationKey[] = [
  "nav.dashboard",
  "nav.orders",
  "nav.kitchenKds",
  "nav.settings",
  "nav.comingSoon",
  "publicMenu.callStaff",
  "publicMenu.staffOnTheWay",
  "publicMenu.checkout",
  "publicMenu.placeOrder",
];

describe("translate", () => {
  it("returns a non-empty string for both locales on every sampled key", () => {
    for (const key of SAMPLE_KEYS) {
      expect(translate(key, "en").length).toBeGreaterThan(0);
      expect(translate(key, "ne").length).toBeGreaterThan(0);
    }
  });

  it("the en and ne values differ (never accidentally left identical/untranslated)", () => {
    for (const key of SAMPLE_KEYS) {
      expect(translate(key, "en")).not.toBe(translate(key, "ne"));
    }
  });

  it("LOCALE_LABELS covers both locales", () => {
    expect(LOCALE_LABELS.en).toBe("English");
    expect(LOCALE_LABELS.ne).toBe("नेपाली");
  });
});

describe("trialDaysLeftText", () => {
  it("singularizes 'day' in English for exactly 1", () => {
    expect(trialDaysLeftText(1, "en")).toBe("1 day left in trial");
    expect(trialDaysLeftText(2, "en")).toBe("2 days left in trial");
    expect(trialDaysLeftText(0, "en")).toBe("0 days left in trial");
  });

  it("renders Nepali digits in the ne form", () => {
    expect(trialDaysLeftText(12, "ne")).toBe("ट्रायलमा १२ दिन बाँकी");
  });
});

describe("cartItemCountText", () => {
  it("singularizes 'item' in English for exactly 1", () => {
    expect(cartItemCountText(1, "en")).toBe("1 item");
    expect(cartItemCountText(3, "en")).toBe("3 items");
  });

  it("renders Nepali digits in the ne form", () => {
    expect(cartItemCountText(4, "ne")).toBe("४ वस्तु");
  });
});
