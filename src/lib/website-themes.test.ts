import { describe, expect, it } from "vitest";
import {
  WEBSITE_THEMES,
  WEBSITE_THEME_LABELS,
  WEBSITE_THEME_DESCRIPTIONS,
  WEBSITE_THEME_CLASSES,
} from "./website-themes";

describe("website-themes", () => {
  it("has a label, description, and class bundle for every theme", () => {
    for (const theme of WEBSITE_THEMES) {
      expect(WEBSITE_THEME_LABELS[theme]).toBeTruthy();
      expect(WEBSITE_THEME_DESCRIPTIONS[theme]).toBeTruthy();
      const classes = WEBSITE_THEME_CLASSES[theme];
      expect(classes.page).toBeTruthy();
      expect(classes.accentBg).toBeTruthy();
      expect(classes.accentText).toBeTruthy();
    }
  });

  it("has no duplicate theme keys", () => {
    expect(new Set(WEBSITE_THEMES).size).toBe(WEBSITE_THEMES.length);
  });
});
